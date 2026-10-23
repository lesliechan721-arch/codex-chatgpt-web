import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "../src/responses/parser";
import type { CodexMessage, CodexParsedRequest } from "../src/types";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { contextSnapshotPriorityImageLocators, createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { ContextNavigator } from "../src/adapters/chatgpt-web/context-navigator";
import { contextErrorReserve, measureContextResponse } from "../src/adapters/chatgpt-web/context-budget";
import { ContextScope } from "../src/adapters/chatgpt-web/context-runtime";
import { planContextDelivery, type ContextDeliveryPlan, type ContextDeliveryPlanInput } from "../src/adapters/chatgpt-web/context-planner";
import { contextAttachmentImage } from "../src/adapters/chatgpt-web/context-media-plan";
import { assertContinuityCompiledInput, preflightContinuityInput } from "../src/adapters/chatgpt-web/continuity-input";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { contextTextReadReceipt, parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import { estimateWebContextFieldCost } from "../src/adapters/chatgpt-web/context-renderer";
import { ContextSend } from "../src/adapters/chatgpt-web/context-send";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

// A large composer limit lets these cases compare complete inline and selective
// delivery costs. The production composer boundary has separate bootstrap tests.
const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false, maxComposerCodePoints: 2_000_000 };
const token = `turn_${"a".repeat(32)}`;
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==";
/** Preserve a valid 2px raster and add an ancillary chunk with a valid CRC. */
function paddedPng(bytes: number): string {
  const base = Buffer.from(png.split(",")[1]!, "base64"), padding = Buffer.alloc(bytes - base.length);
  padding.writeUInt32BE(padding.length - 12); padding.write("paDd", 4);
  let crc = 0xffffffff;
  for (const byte of padding.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  padding.writeUInt32BE((crc ^ 0xffffffff) >>> 0, padding.length - 4);
  return `data:image/png;base64,${Buffer.concat([base.subarray(0, 33), padding, base.subarray(33)]).toString("base64")}`;
}
function request(messages: CodexMessage[]): CodexParsedRequest {
  return { modelId: CHATGPT_WEB_MODEL_ID, context: { systemPrompt: ["Keep system instruction."], messages }, stream: true, options: { reasoning: "high" } };
}
function logRequest(text: string): CodexParsedRequest {
  return request([
    { role: "user", content: "Run the test and check the recorded result.", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "log-call", name: "exec_command", arguments: { cmd: "bun test" } }], timestamp: 2 },
    { role: "toolResult", toolCallId: "log-call", toolName: "exec_command", content: text, isError: false, timestamp: 3 },
    { role: "user", content: "Use the existing result.", timestamp: 4 },
  ]);
}
function plan(canonical: CodexParsedRequest, overrides: Partial<ContextDeliveryPlanInput> = {}): ContextDeliveryPlan {
  return planContextDelivery({ canonical, snapshot: overrides.snapshot ?? createContextSnapshot(canonical), candidate: canonical, capabilities,
    turnToken: token, contextToolsAvailable: true, ...overrides });
}
function entry(result: ContextDeliveryPlan): Record<string, any> {
  const match = /<codex_bootstrap_json>\n([^\n]+)\n<\/codex_bootstrap_json>/.exec(result.compiled.text);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}
function navigator(result: ContextDeliveryPlan): ContextNavigator {
  const published = entry(result);
  expect(published.context_id).toBe(result.registration!.snapshot.context_id);
  return new ContextNavigator({ scopeId: token, snapshot: result.registration!.snapshot, purpose: "normal",
    deliveryByTarget: result.registration!.deliveryByTarget, limits: result.registration!.limits });
}
function entries(result: ContextDeliveryPlan): Array<Record<string, any>> {
  const nav = navigator(result), published = entry(result), all: Array<Record<string, any>> = [];
  let cursor: string | undefined;
  do {
    const response = nav.list({ context_id: published.context_id, view: "entries", ...(cursor ? { cursor } : {}) });
    expect(response.isError).not.toBe(true);
    const body = response.structuredContent as Record<string, any>;
    all.push(...body.entries); cursor = body.next_cursor ?? undefined;
  } while (cursor);
  return all;
}

function readText(result: ContextDeliveryPlan, readRef: string): string {
  const nav = navigator(result);
  let text = "", cursor: string | undefined;
  do {
    const response = nav.read({ context_id: result.snapshot.context_id, reads: [{ read_ref: readRef, ...(cursor ? { cursor } : {}) }] });
    expect(response.isError).not.toBe(true);
    const page = parseContextTextReadResult(response);
    text += page.bodies[0]!;
    cursor = page.metadata.items[0]!.next_cursor ?? undefined;
  } while (cursor);
  return text;
}

function payload(result: ContextDeliveryPlan): Record<string, any> {
  const target = result.snapshot.targets.find(value => value.origin === "context_bootstrap_payload")!;
  expect(result.registration!.deliveryByTarget[target.target_id]!.required).toBe(true);
  const value = JSON.parse(readText(result, target.read_ref!));
  expect(value.format).toBe("context-bootstrap-payload-v3");
  return value;
}

function externalizedSources(result: ContextDeliveryPlan): string[] {
  return result.snapshot.targets.filter(target => target.origin !== "context_bootstrap_payload"
    && target.origin !== "context_bootstrap_protocol" && result.externalizedTargetIds.includes(target.target_id))
    .map(target => target.target_id);
}

function requiredImages(result: ContextDeliveryPlan): number {
  const scope = new ContextScope(token, result.registration!, "normal", () => {}, error => { throw error; });
  try { return scope.status().required_images; } finally { scope.retire(); }
}

function deliverRequired(scope: ContextScope): void {
  for (let count = 0; !scope.status().context_ready && count < 500; count++) {
    const next = scope.status().next_required_read;
    expect(next).not.toBeNull();
    const reply = scope.prepare("read", next!.arguments);
    expect(reply.result.isError).not.toBe(true);
    scope.finish(reply.receiptId, true, reply.result.content.some((value: any) => value.type === "image")
      ? undefined : contextTextReadReceipt(reply.result));
  }
  expect(scope.status().context_ready).toBe(true);
}

test("large history fields use v3 placements and exact pagination without changing canonical sources", () => {
  const text = "日志🙂 line with \\\"quoted\\\" path\\n".repeat(1500);
  const canonical = logRequest(text), snapshot = createContextSnapshot(canonical);
  const before = structuredClone(canonical), sourceBefore = snapshot.toWire();
  const result = plan(canonical, { snapshot });
  expect(result.navigationEnabled).toBe(true);
  expect(externalizedSources(result).length).toBeGreaterThan(0);
  expect(result.registration!.startupProtocol).toBe("context-bootstrap-v1");
  expect(result.costs.netSavedPromptBytes).toBeGreaterThan(0);
  expect(entry(result).first_call.arguments.turn_token).toBe(token);
  expect(result.compiled.turnToken).toBe(token);
  expect(result.compiled.text.split(token)).toHaveLength(2);
  expect(canonical).toEqual(before);
  expect(snapshot.toWire()).toEqual(sourceBefore);
  const field = entries(result).find(value => value.kind === "tool_result")!;
  const nav = navigator(result), contextId = entry(result).context_id;
  let read = "", cursor: string | undefined, end = 0;
  do {
    const response = nav.read({ context_id: contextId, reads: [{ read_ref: field.read_ref, ...(cursor ? { cursor } : {}) }] });
    expect(response.isError).not.toBe(true);
    const page = parseContextTextReadResult(response);
    expect(page.metadata.items).toHaveLength(1);
    const body = page.metadata.items[0]!;
    expect(body.range.start).toBe(end);
    const textPage = page.bodies[0]!;
    expect(textPage).not.toContain("�");
    expect(body.range.end_exclusive).toBeGreaterThan(end);
    read += textPage; end = body.range.end_exclusive; cursor = body.next_cursor ?? undefined;
  } while (cursor);
  expect(read).toBe(text);
  expect(end).toBe(Buffer.byteLength(text));
  const source = payload(result), position = source.external_positions.find((value: any) => value.target_id === field.target_id);
  expect(position).toMatchObject({ path: ["messages", 2, "content"], original_role: "toolResult", source_index: field.source_index,
    read_ref: field.read_ref, content_digest: field.content_digest, utf8_bytes: Buffer.byteLength(text) });
  expect(source.payload.messages[2].content).toBeNull();
  source.payload.messages[2].content = read;
  expect(source.payload.system).toEqual(["Keep system instruction."]);
  expect(source.payload.messages[0].content).toBe("Run the test and check the recorded result.");
  expect(source.payload.messages[3].content).toBe("Use the existing result.");
  const mapTarget = result.snapshot.targets.find(value => value.origin === "context_source_map")!;
  expect(source.source_map).toMatchObject({ context_id: result.snapshot.context_id, target_id: mapTarget.target_id,
    read_ref: mapTarget.read_ref, content_digest: mapTarget.content_digest });
  expect(result.registration!.deliveryByTarget[mapTarget.target_id]).toMatchObject({ required: false, delivery: "source_on_demand" });
  expect(source.sources).toBeUndefined();
  expect(source.targets).toBeUndefined();
  const mapping = JSON.parse(readText(result, mapTarget.read_ref!));
  expect(mapping.targets.some((value: any) => value.target_id === mapTarget.target_id)).toBe(false);
});

test("short fields and a negative full-prompt benefit keep the original fast path", () => {
  for (const text of ["ok", "x".repeat(1800)]) {
    const canonical = logRequest(text), result = plan(canonical);
    expect(result.navigationEnabled).toBe(false);
    expect(result.registration).toBeUndefined();
    expect(result.compiled).toEqual(compileChatGptWebPrompt(canonical, capabilities, token));
  }
});

for (const manual of [false, true]) for (const length of [6000, 10000]) {
  test(`${manual ? "Zero Risk" : "Automatic"} keeps low-token logs inline after full navigation costs`, () => {
    const canonical = logRequest("A".repeat(length)), snapshot = createContextSnapshot(canonical);
    const compileOptions = manual ? { manualControl: true as const } : {};
    const inline = plan(canonical, { snapshot, compileOptions, contextToolsAvailable: false });
    const result = plan(canonical, { snapshot, compileOptions });
    expect(result.navigationEnabled).toBe(false);
    expect(externalizedSources(result)).toHaveLength(0);
    expect(result.compiled).toEqual(inline.compiled);
    expect(result.costs.requiredTotalTokens).toBe(inline.costs.requiredTotalTokens);
    expect(result.costs.discoveryReserveTokens).toBe(0);
    expect(result.costs.errorReserveTokens).toBe(0);
  });
}

test("page estimates do not reject inline delivery or force a new send plan", async () => {
  const canonical = logRequest("A".repeat(6000)), snapshot = createContextSnapshot(canonical);
  const baseline = plan(canonical, { snapshot, contextToolsAvailable: false });
  for (const retainedTokens of [89_999, 90_001, 599_999, 600_001, 1_000_000]) {
    const inline = plan(canonical, { snapshot, contextToolsAvailable: false, budget: { retainedTokens, contextWindowTokens: 1 } });
    const result = plan(canonical, { snapshot, budget: { retainedTokens, contextWindowTokens: 1 } });
    expect(result.navigationEnabled).toBe(false);
    expect(result.compiled).toEqual(baseline.compiled);
    expect(result.costs.requiredTotalTokens).toBe(baseline.costs.requiredTotalTokens + retainedTokens);
    expect(result.costs.requiredTotalTokens).toBe(inline.costs.requiredTotalTokens);
  }
  const broker = TurnBroker.forSocket(join(tmpdir(), `context-cost-${randomUUID()}.sock`));
  const reuseCapability = spyOn(broker, "contextReuseAvailable").mockReturnValue(false);
  const send = new ContextSend(canonical, broker, capabilities, "cost-boundary", undefined, undefined, snapshot);
  try {
    const prepared = await send.prepare(canonical, token, {}, 1_000_000);
    expect(prepared.navigationEnabled).toBe(false);
    expect(prepared.compiled).toEqual(baseline.compiled);
    await send.select(token, prepared);
    await send.sent();
    expect(send.coverage.latest()?.delivered).toBe(true);
  } finally { send.retire(); reuseCapability.mockRestore(); await broker.close(); }
});

test("selective delivery is available below input capacity and beyond page estimates", () => {
  const text = "recorded result line\n".repeat(3000);
  const canonical = logRequest(text), snapshot = createContextSnapshot(canonical);
  const inline = plan(canonical, { snapshot, contextToolsAvailable: false });
  for (const budget of [{ contextWindowTokens: 1 }, { contextWindowTokens: 1, retainedTokens: 1_000_000 }]) {
    const result = plan(canonical, { snapshot, budget });
    expect(result.navigationEnabled).toBe(true);
    expect(externalizedSources(result).length).toBeGreaterThan(0);
    expect(result.costs.requiredTotalTokens - (budget.retainedTokens ?? 0)).toBeLessThan(inline.costs.requiredTotalTokens);
    expect(readText(result, entries(result).find(value => value.kind === "tool_result")!.read_ref)).toBe(text);
  }
});

test("omitted history requires a current directory while selected fields keep exact values", () => {
  const canonical = logRequest(" ".repeat(6000));
  canonical.context.messages.unshift({ role: "toolResult", toolCallId: "older-call", toolName: "exec_command",
    content: "omitted readable result", isError: false, timestamp: 0 });
  const snapshot = createContextSnapshot(canonical);
  const candidate = { ...canonical, context: { ...canonical.context, messages: canonical.context.messages.slice(1) } };
  const result = plan(canonical, { snapshot, candidate, budget: { retainedTokens: 1_000_000, contextWindowTokens: 1 } });
  expect(result.navigationEnabled).toBe(true);
  expect(result.costs.discoveryReserveTokens).toBeGreaterThan(0);
  expect(result.costs.errorReserveTokens).toBeGreaterThan(0);
  const older = entries(result).find(value => value.call_id === "older-call")!;
  expect(older.delivery).toBe("source_on_demand");
  expect(readText(result, older.read_ref)).toBe("omitted readable result");
  const selected = entries(result).find(value => value.call_id === "log-call" && value.kind === "tool_result")!;
  expect(readText(result, selected.read_ref)).toBe(" ".repeat(6000));
  const scope = new ContextScope(token, result.registration!, "normal", () => {}, error => { throw error; });
  try { scope.markEntryDelivered(); deliverRequired(scope); } finally { scope.retire(); }
});

test("an incompatible current context contract cannot silently drop omitted history", () => {
  const canonical = logRequest("historical evidence must remain available");
  const candidate = { ...canonical, context: { ...canonical.context, messages: canonical.context.messages.slice(-1) } };
  expect(plan(canonical, { candidate }).navigationEnabled).toBe(true);
  expect(() => plan(canonical, { candidate, contextToolsAvailable: false })).toThrow("Refresh its context tool schema");
  const complete = plan(canonical, { contextToolsAvailable: false });
  expect(complete.navigationEnabled).toBe(false);
  expect(complete.compiled.text).toContain("historical evidence must remain available");
});

test("plan costs and body identity use the chosen presentation of the same selected input", () => {
  const canonical = request([{ role: "user", content: JSON.stringify(Array.from({ length: 400 }, (_, i) => ({
    id: i, value: '"quoted"', path: `C:\\source\\${i}.ts`,
  }))), timestamp: 1 }]);
  const snapshot = createContextSnapshot(canonical), before = structuredClone(canonical);
  const legacy = plan(canonical, { snapshot, contextToolsAvailable: false, compileOptions: { contextRendering: "legacy-json" } });
  const chosen = plan(canonical, { snapshot, contextToolsAvailable: false });
  expect(chosen.compiled.contextFormat).toBe("codex-context-text-v1");
  expect(chosen.costs.contextFormat).toBe(chosen.compiled.contextFormat!);
  expect(chosen.costs.promptTokens).toBeLessThan(legacy.costs.promptTokens);
  expect(chosen.costs.promptJsonBytes).toBeLessThanOrEqual(legacy.costs.promptJsonBytes);
  expect(chosen.costs.promptJsonBytes).toBe(Buffer.byteLength(JSON.stringify(chosen.compiled.text)));
  expect(chosen.costs.promptCharacters).toBe(chosen.compiled.text.length);
  expect(chosen.bodyDigest).not.toBe(legacy.bodyDigest);
  expect(chosen.navigationEnabled).toBe(false);
  expect(canonical).toEqual(before);
});

test("externalization threshold uses mixed field cost instead of escaped JSON savings", () => {
  const text = '"'.repeat(600);
  const raw = estimateWebContextFieldCost(text, { contextFormat: "codex-context-text-v1", path: ["message", "content"] });
  const json = estimateWebContextFieldCost(text, { contextFormat: "legacy-json", path: ["message", "content"] });
  expect(raw.jsonBytes).toBeLessThan(json.jsonBytes);
  const canonical = logRequest(text);
  canonical.context.systemPrompt = [JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, value: '"quoted"' })))];
  const result = plan(canonical);
  expect(result.compiled.contextFormat).toBe("codex-context-text-v1");
  expect(externalizedSources(result)).toHaveLength(0);
  expect(result.navigationEnabled).toBe(false);
});

test("multiple medium fields can jointly repay the complete entry cost", () => {
  // Leave room for token-count variation in random navigation IDs and read references.
  // Each field alone must still cost less inline than with a complete navigation entry.
  const canonical = request(Array.from({ length: 6 }, (_, index) => ({ role: "toolResult" as const, toolCallId: `c${index}`,
    toolName: "exec_command", content: `result ${index}: ${"result line\n".repeat(1200)}`, isError: false, timestamp: index })));
  for (const message of canonical.context.messages) {
    expect(plan(request([message])).navigationEnabled).toBe(false);
  }
  const snapshot = createContextSnapshot(canonical);
  const inline = plan(canonical, { snapshot, contextToolsAvailable: false });
  const result = plan(canonical, { snapshot });
  expect(result.navigationEnabled).toBe(true);
  expect(externalizedSources(result)).toHaveLength(6);
  expect(result.costs.netSavedPromptBytes).toBeGreaterThan(0);
  expect(result.costs.requiredTotalTokens).toBeLessThan(inline.costs.requiredTotalTokens);
});

test("resume and short second-round inputs publish a new visible entry for omitted readable history", () => {
  const text = "unique unread suffix\n".repeat(2000);
  const canonical = logRequest(text), snapshot = createContextSnapshot(canonical);
  const full = plan(canonical, { snapshot });
  const candidate = { ...canonical, context: { ...canonical.context, messages: canonical.context.messages.slice(-1) } };
  const resume = plan(canonical, { snapshot, candidate, compileOptions: { retainedContinuity: true } });
  expect(resume.navigationEnabled).toBe(true);
  expect(externalizedSources(resume)).toHaveLength(0);
  expect(resume.planId).not.toBe(full.planId);
  expect(resume.registration!.snapshot.context_id).not.toBe(snapshot.context_id);
  expect(snapshot.getText(snapshot.targets.find(value => value.kind === "tool_result")!.read_ref!)).toBe(text);
  expect(resume.compiled.text).not.toContain("unique unread suffix\\n".repeat(10));
  expect(resume.costs.promptBytes).toBe(Buffer.byteLength(resume.compiled.text));
  expect(entry(resume).first_call.arguments.turn_token).toBe(token);
  const field = entries(resume).find(value => value.kind === "tool_result")!;
  expect(field.delivery).toBe("source_on_demand");
  const read = navigator(resume).read({ context_id: entry(resume).context_id, reads: [{ read_ref: field.read_ref }] });
  expect(parseContextTextReadResult(read).bodies).toHaveLength(1);
  expect(parseContextTextReadResult(read).bodies[0]).toContain("unique unread suffix");
});

test("re-parsed candidates require an explicit map and do not infer repeated call identities", () => {
  const canonical = logRequest("result\n".repeat(3000));
  canonical.context.messages.push(structuredClone(canonical.context.messages[2]!));
  const candidate = structuredClone(canonical);
  expect(() => plan(canonical, { candidate })).toThrow("no exact canonical mapping");
  const result = plan(canonical, { candidate, messageIndices: canonical.context.messages.map((_, index) => index) });
  expect(entries(result).filter(value => value.kind === "tool_result")).toHaveLength(2);
  const synthetic = request([{ role: "user", content: "Continue with the new instruction.", timestamp: 99 }]);
  expect(plan(canonical, { candidate: synthetic, messageIndices: [null] }).navigationEnabled).toBe(true);
  expect(() => plan(canonical, { candidate: synthetic, messageIndices: [0] })).toThrow("no exact canonical mapping");
});

test("rules, user history, skills, delegation and trusted summaries remain required while ordinary assistant history is optional", () => {
  const marker = "protected evidence ".repeat(1000);
  const canonical = request([
    { role: "developer", content: marker, timestamp: 0 },
    { role: "user", origin: "codex_skill", content: marker, timestamp: 1 },
    { role: "agentMessage", author: "parent", recipient: "worker", content: marker, timestamp: 2 },
    { role: "assistant", content: [{ type: "text", text: marker }], timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "ordinary explanation\n".repeat(5000) }], timestamp: 4 },
    { role: "user", content: marker, timestamp: 5 },
    { role: "user", content: "Apply the second option in your previous answer.", timestamp: 6 },
  ]);
  canonical.context.systemPrompt = [marker];
  const snapshot = createContextSnapshot(canonical, { provenanceByMessage: new Map([[3, { source_kind: "summary" }]]) });
  const result = plan(canonical, { snapshot, capabilities: { ...capabilities, maxComposerCodePoints: 8000 } });
  const source = payload(result);
  expect(source.payload.system).toEqual([marker]);
  expect(source.payload.messages.slice(0, 4).map((value: any) => value.content)).toEqual([
    marker, marker, marker, [{ type: "text", text: marker }],
  ]);
  expect(source.payload.messages[5].content).toBe(marker);
  expect(source.payload.messages[6].content).toBe("Apply the second option in your previous answer.");
  expect(source.payload.messages[4].content[0].text).toBeNull();
  const ordinary = entries(result).find(value => value.source_kind === "assistant" && value.kind === "message_text")!;
  expect(ordinary).toMatchObject({ required: false, delivery: "source_on_demand", original_role: "assistant" });
  expect(readText(result, ordinary.read_ref)).toBe("ordinary explanation\n".repeat(5000));
  for (const value of entries(result).filter(value => snapshot.targets.some(target => target.target_id === value.target_id)
    && ["system", "developer", "skill", "agent_message", "delegation", "summary", "user"].includes(value.source_kind))) {
    expect(value.delivery).toBe("source_required_record");
  }
  const scope = new ContextScope(token, result.registration!, "normal", () => {}, error => { throw error; });
  try {
    scope.markEntryDelivered();
    deliverRequired(scope);
    expect(scope.status().context_ready).toBe(true);
    expect(scope.navigator.usage().text_tokens).toBeLessThan(result.costs.requiredTotalTokens);
  } finally { scope.retire(); }
});

test("raw invalid JSON, freeform input and multi-block outputs remain exact when field mapping is unproven", () => {
  const invalid = "not JSON 🙂 ".repeat(1000), freeform = "*** patch 原文\n".repeat(1000);
  const first = "前段🙂\n".repeat(1200), second = "后段\\\"\n".repeat(1200);
  const canonical = parseRequest({ model: CHATGPT_WEB_MODEL_ID, reasoning: { effort: "high" }, input: [
    { type: "function_call", call_id: "bad-json", name: "exec_command", arguments: invalid },
    { type: "function_call_output", call_id: "bad-json", output: [{ type: "text", text: first }, { type: "text", text: second }] },
    { type: "custom_tool_call", call_id: "freeform", name: "apply_patch", input: freeform },
    { role: "user", content: "Check the recorded data." },
  ] });
  const result = plan(canonical, { capabilities: { ...capabilities, maxComposerCodePoints: 8000 } });
  const snapshot = result.snapshot;
  const callFields = snapshot.targets.filter(value => value.kind === "tool_arguments");
  expect(readText(result, callFields[0]!.read_ref!)).toBe(invalid);
  expect(readText(result, callFields[1]!.read_ref!)).toBe(freeform);
  const outputs = snapshot.targets.filter(value => value.kind === "tool_result");
  expect(outputs.map(value => readText(result, value.read_ref!))).toEqual([first, second]);
  const source = payload(result);
  const output = source.payload.messages.find((value: any) => value.role === "tool_result");
  expect(output.content).toBe(`${first}${second}`);
  expect(source.external_positions.some((value: any) => outputs.some(target => value.target_id === target.target_id))).toBe(false);
  expect(source.external_positions.some((value: any) => value.target_id === callFields[0]!.target_id)).toBe(false);
  expect(canonical.context.messages.find(value => value.role === "toolResult")!.content).toBe(`${first}${second}`);
});

test("each optional field keeps its original source position even when lengths and values repeat", () => {
  const canonical = request([3000, 9000, 3000].map((length, index) => ({ role: "toolResult" as const, toolCallId: `c${index}`,
    toolName: "exec_command", content: "log line\n".repeat(length / 10), isError: false, timestamp: index })));
  const result = plan(canonical, { capabilities: { ...capabilities, maxComposerCodePoints: 8000 } });
  const source = payload(result);
  expect(source.external_positions).toHaveLength(3);
  for (const [index, message] of canonical.context.messages.entries()) {
    if (typeof message.content !== "string") throw new Error("This fixture must contain text messages");
    const placement = source.external_positions.find((value: any) => value.path[1] === index);
    expect(placement.path).toEqual(["messages", index, "content"]);
    expect(readText(result, placement.read_ref)).toBe(message.content);
  }
  expect(new Set(source.external_positions.map((value: any) => value.target_id)).size).toBe(3);
});

test("partial and full log replays count complete MCP response overhead and repeated reads", () => {
  const canonical = logRequest("line: test evidence unique-result\n".repeat(3000)), result = plan(canonical);
  const nav = navigator(result), contextId = entry(result).context_id;
  let listCursor: string | undefined, field: Record<string, any> | undefined, wire = 0;
  do {
    const response = nav.list({ context_id: contextId, view: "entries", ...(listCursor ? { cursor: listCursor } : {}) });
    expect(response.isError).not.toBe(true);
    wire += measureContextResponse(response).wire_bytes;
    const body = response.structuredContent as any;
    field ??= body.entries.find((value: any) => value.kind === "tool_result");
    listCursor = body.next_cursor ?? undefined;
  } while (listCursor);
  const search = nav.search({ context_id: contextId, read_ref: field!.read_ref, query: "unique-result" });
  expect(search.isError).not.toBe(true);
  wire += measureContextResponse(search).wire_bytes;
  let cursor: string | undefined, calls = 0, partial = 0;
  do {
    const response = nav.read({ context_id: contextId, reads: [{ read_ref: field!.read_ref, ...(cursor ? { cursor } : {}) }] });
    expect(response.isError).not.toBe(true);
    wire += measureContextResponse(response).wire_bytes; calls++;
    if (calls === 1) partial = wire;
    const parsed = parseContextTextReadResult(response);
    expect(parsed.metadata.items).toHaveLength(1);
    cursor = parsed.metadata.items[0]!.next_cursor ?? undefined;
  } while (cursor);
  expect(result.costs.promptBytes + partial).toBeLessThan(result.costs.originalPromptBytes);
  expect(result.costs.promptBytes + wire).toBeGreaterThan(result.costs.originalPromptBytes);
  const repeated = nav.read({ context_id: contextId, reads: [{ read_ref: field!.read_ref }] });
  expect(nav.usage().wire_bytes).toBe(wire + measureContextResponse(repeated).wire_bytes);
  expect(calls).toBeGreaterThan(1);
});

test("short inputs with more than ten required MCP images do not enter composer attachment slots", () => {
  const canonical = request([{ role: "user", content: Array.from({ length: 12 }, () => ({ type: "image" as const, imageUrl: png })), timestamp: 1 }]);
  const result = plan(canonical);
  expect(result.navigationEnabled).toBe(true);
  expect(result.compiled.images).toHaveLength(0);
  expect(requiredImages(result)).toBe(12);
  expect(entries(result).filter(value => value.kind === "image").every(value => value.media_route === "mcp" && value.required && value.read_ref)).toBe(true);
  expect(result.costs.requiredMcpTokens).toBeGreaterThan(12 * 4096);
  const first = result.registration!.snapshot.targets.find(value => value.kind === "image")!;
  const read = navigator(result).read({ context_id: entry(result).context_id, reads: [{ read_ref: first.read_ref! }] });
  expect(read.content.filter((value: any) => value.type === "image")).toHaveLength(1);
  expect(JSON.stringify(read.structuredContent)).not.toContain("iVBOR");
});

test("mixed MCP and attachment routes have separate manifests and no fake read references", () => {
  const canonical = request([{ role: "user", content: [{ type: "image", imageUrl: png }, { type: "image", imageUrl: png }], timestamp: 1 }]);
  const result = plan(canonical, { limits: { maxImageReads: 1 } });
  expect(result.compiled.images).toHaveLength(1);
  expect(result.compiled.contextPlan!.requiredAttachments).toHaveLength(1);
  const pictures = entries(result).filter(value => value.kind === "image");
  expect(pictures[0]!.media_route).toBe("mcp");
  expect(pictures[1]!.media_route).toBe("attachment");
  expect(pictures[1]!.read_ref).toBeNull();
  expect(pictures[1]!.reason).toBeTruthy();
});

test("legal one-pixel images survive the selected navigation attachment route", () => {
  const onePixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  const canonical = request([{ role: "user", content: [{ type: "image", imageUrl: onePixel }], timestamp: 1 }]);
  expect(compileChatGptWebPrompt(canonical, capabilities, token).images).toHaveLength(0);
  const result = plan(canonical, { limits: { maxImageBytes: 1 } });
  expect(result.compiled.images).toHaveLength(1);
  expect(result.compiled.images[0]!.imageUrl).toBe(onePixel);
  expect(result.compiled.contextPlan!.requiredAttachments).toHaveLength(1);
  expect(entries(result).find(value => value.kind === "image")!.media_route).toBe("attachment");
});

test("omitted fixed historical images are discoverable and remain optional", () => {
  const canonical = request([{ role: "user", content: [{ type: "image", imageUrl: png }], timestamp: 1 },
    { role: "toolResult", toolCallId: "view", toolName: "view_image", content: [{ type: "image", imageUrl: png }], isError: false, timestamp: 2 },
    { role: "user", content: "Continue.", timestamp: 3 }]);
  const candidate = { ...canonical, context: { ...canonical.context, messages: canonical.context.messages.slice(-1) } };
  const result = plan(canonical, { candidate });
  expect(requiredImages(result)).toBe(0);
  expect(entries(result).filter(value => value.kind === "image").every(value => !value.required && value.media_route === "mcp" && value.read_ref)).toBe(true);
  expect(result.compiled.images).toHaveLength(0);
});

test("bounded optional image history preserves the current required image in planning and ordinary preflight", () => {
  const large = paddedPng(3 * 1024 * 1024);
  const canonical = request([...Array.from({ length: 9 }, (_, index) => ({ role: "toolResult" as const,
    toolCallId: `history-image-${index}`, toolName: "view_image", content: [{ type: "image" as const, imageUrl: large }], isError: false, timestamp: index })),
    { role: "user", content: [{ type: "text", text: "Inspect the current picture." }, { type: "image", imageUrl: png }], timestamp: 10 }]);
  const snapshot = createContextSnapshot(canonical, { imageStoragePolicy: "bounded",
    priorityImageLocators: contextSnapshotPriorityImageLocators(canonical, { messageIndices: [9], rawInputIndices: [] }) });
  expect(snapshot.storage_bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  const current = snapshot.targets.find(target => target.kind === "image" && target.locator.message_index === 9)!;
  expect(current.read_ref).toBeTruthy();
  expect(snapshot.getImage(current.read_ref!)!.bytes).toEqual(Buffer.from(png.split(",")[1]!, "base64"));
  const historical = snapshot.targets.filter(target => target.kind === "image" && target.source_kind === "tool");
  expect(historical).toHaveLength(9);
  expect(historical.some(target => !target.read_ref && target.unavailable_reason)).toBe(true);
  const candidate = { ...canonical, context: { ...canonical.context, messages: canonical.context.messages.slice(-1) } };
  const result = plan(canonical, { snapshot, candidate });
  expect(result.registration!.deliveryByTarget[current.target_id]).toMatchObject({ required: true, media_route: "mcp" });
  expect(result.compiled.images).toHaveLength(0);
  const returned = navigator(result).read({ context_id: result.snapshot.context_id, reads: [{ read_ref: current.read_ref! }] });
  expect(returned.isError).not.toBe(true);
  expect(returned.content.some((block: any) => block.type === "image")).toBe(true);
  expect(() => preflightContinuityInput(canonical, capabilities)).not.toThrow();
  expect(canonical.context.messages[9]!.content).toEqual([{ type: "text", text: "Inspect the current picture." }, { type: "image", imageUrl: png }]);
}, 30_000);

test("unavailable tool-history images have bounded reasons; unavailable required images fail before send", () => {
  const optional = request([{ role: "toolResult", toolCallId: "view", toolName: "view_image",
    content: [{ type: "image", imageUrl: "https://example.invalid/image.png" }], isError: false, timestamp: 1 }]);
  const result = plan(optional);
  const picture = entries(result).find(value => value.kind === "image")!;
  expect(picture.media_route).toBe("unavailable");
  expect(picture.read_ref).toBeNull();
  expect(picture.reason.length).toBeLessThanOrEqual(240);
  const required = request([{ role: "user", content: [{ type: "image", imageUrl: "file_id:image-1" }], timestamp: 1 }]);
  expect(() => plan(required)).toThrow("cannot be delivered");
  expect(() => plan(request([{ role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,broken" }], timestamp: 1 }]))).toThrow("cannot be delivered");
});

test("invalid encoded images cannot bypass source validation through attachment fallback", () => {
  const bad = ["data:image/png;base64,SGVsbG8=", png.replace("FGMynQ", "FGMynA"),
    `data:image/png;base64,${Buffer.from(png.split(",")[1]!, "base64").subarray(0, 40).toString("base64")}`];
  for (const imageUrl of bad) {
    expect(contextAttachmentImage(imageUrl)).toBeUndefined();
    const required = request([{ role: "user", content: [{ type: "image", imageUrl }], timestamp: 1 }]);
    expect(() => plan(required, { limits: { maxImageBytes: 1 } })).toThrow("cannot be delivered");
    const optional = request([{ role: "toolResult", toolCallId: "view", toolName: "view_image",
      content: [{ type: "image", imageUrl }], isError: false, timestamp: 1 }]);
    const result = plan(optional, { limits: { maxImageBytes: 1 } });
    expect(result.compiled.images).toHaveLength(0);
    const image = entries(result).find(value => value.kind === "image")!;
    expect(image.media_route).toBe("unavailable");
    expect(image.read_ref).toBeNull();
  }
});

test("required attachment overflow remains independent of page estimates", () => {
  const canonical = request([{ role: "user", content: Array.from({ length: 12 }, () => ({ type: "image" as const, imageUrl: png })), timestamp: 1 }]);
  expect(() => plan(canonical, { limits: { maxImageReads: 1 } })).toThrow("cannot be delivered");
  const admitted = plan(canonical, { budget: { contextWindowTokens: 1, retainedTokens: 1_000_000 } });
  expect(requiredImages(admitted)).toBe(12);
  expect(contextAttachmentImage("https://example.invalid/a.png")).toBeUndefined();
  expect(contextAttachmentImage("data:image/svg+xml;base64,PHN2Zz4=")).toBeUndefined();
  expect(contextAttachmentImage("data:image/png;base64,")).toBeUndefined();
  expect(contextAttachmentImage(png)?.bytes).toBeGreaterThan(0);
});

test("long required rules remain exact in full and retained plans without a cumulative window gate", () => {
  const canonical = logRequest("log\n".repeat(2000));
  const rule = "instruction\n".repeat(15000);
  canonical.context.messages.unshift({ role: "developer", content: rule, timestamp: 0 });
  const snapshot = createContextSnapshot(canonical), candidate = { ...canonical, context: { ...canonical.context, messages: canonical.context.messages.slice(-1) } };
  const full = plan(canonical, { snapshot, capabilities: { ...capabilities, maxComposerCodePoints: 8000 },
    budget: { contextWindowTokens: 1, retainedTokens: 1_000_000 } });
  expect(payload(full).payload.messages[0].content).toBe(rule);
  expect(full.costs.requiredMcpTokens).toBeGreaterThan(20_000);
  const retained = plan(canonical, { snapshot, candidate, budget: { contextWindowTokens: 1, retainedTokens: 1_000_000 } });
  expect(payload(retained).payload.messages.map((value: any) => value.content)).toEqual(["Use the existing result."]);
  const historicalRule = entries(retained).find(value => value.source_kind === "developer")!;
  expect(readText(retained, historicalRule.read_ref)).toBe(rule);
});

test("unverified ABI and non-MCP paths retain the real original compilation", () => {
  const canonical = logRequest("log\n".repeat(5000));
  expect(plan(canonical, { contextToolsAvailable: false }).compiled).toEqual(compileChatGptWebPrompt(canonical, capabilities, token));
  const result = plan(canonical, { capabilities: { ...capabilities, localToolsEnabled: false }, turnToken: undefined });
  expect(result.navigationEnabled).toBe(false);
});

test("continuity preflight uses the selected projection for tool history and MCP images", () => {
  const canonical = request([{ role: "user", content: Array.from({ length: 12 }, () => ({ type: "image" as const, imageUrl: png })), timestamp: 1 },
    { role: "toolResult", toolCallId: "long", toolName: "exec_command", content: "line of evidence\n".repeat(35_000), isError: false, timestamp: 2 }]);
  const before = structuredClone(canonical);
  expect(() => preflightContinuityInput(canonical, capabilities)).not.toThrow();
  expect(canonical).toEqual(before);
});

test("new recovery pages admit selected image routes and keep original bytes", () => {
  for (const manual of [false, true]) {
    const canonical = request([{ role: "user", content: Array.from({ length: 12 }, () => ({ type: "image" as const, imageUrl: png })), timestamp: 1 }]);
    if (manual) canonical.modelId = CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL;
    const before = structuredClone(canonical);
    const full = compileChatGptWebPrompt(canonical, capabilities, token, manual ? { manualControl: true } : {});
    expect(() => assertContinuityCompiledInput(full, canonical, capabilities)).toThrow("original single-input boundary");
    expect(() => preflightContinuityInput(canonical, capabilities)).not.toThrow();
    expect(canonical).toEqual(before);
  }
});

test("small proved recovery inputs preserve their selected inline contract", () => {
  for (const manual of [false, true]) {
    const canonical = logRequest("accepted exact tool result\n".repeat(300));
    canonical.context.messages[0]!.content = [{ type: "text", text: "Continue the accepted instruction." }, { type: "image", imageUrl: png }];
    if (manual) canonical.modelId = CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL;
    const before = structuredClone(canonical);
    expect(() => preflightContinuityInput(canonical, capabilities)).not.toThrow();
    expect(canonical).toEqual(before);
  }
});

test("oversized recovery tool history is admitted by the selected on-demand plan", () => {
  const canonical = logRequest("original recovery log\n".repeat(80_000)), before = structuredClone(canonical);
  expect(() => preflightContinuityInput(canonical, capabilities)).not.toThrow();
  expect(() => assertContinuityCompiledInput(compileChatGptWebPrompt(canonical, capabilities, token), canonical, capabilities)).toThrow();
  expect(canonical).toEqual(before);
}, 30_000);

test("raw system images keep their source role for MCP, attachments and retained selection", () => {
  const canonical = parseRequest({ model: CHATGPT_WEB_MODEL_ID, reasoning: { effort: "high" }, input: [
    { role: "system", content: [{ type: "input_text", text: "System image rule." }, { type: "input_image", image_url: png }, { type: "input_text", text: "Keep this rule." }] },
    { role: "system", content: [{ type: "input_image", image_url: png }] },
    { role: "user", content: "Inspect the system-source images." },
  ] });
  const before = structuredClone(canonical), snapshot = createContextSnapshot(canonical);
  const result = plan(canonical, { snapshot });
  expect(requiredImages(result)).toBe(2);
  expect(result.compiled.images).toHaveLength(0);
  expect(result.projected.context.systemPrompt?.join("\n")).toContain("System image rule.");
  expect(payload(result).payload.system.join("\n")).toContain("codex_context_ref");
  expect(entries(result).filter(value => value.kind === "image").every(value => value.original_role === "system" && value.required)).toBe(true);
  const mixed = plan(canonical, { snapshot, limits: { maxImageReads: 1 } });
  expect(mixed.compiled.images).toHaveLength(1);
  const envelope = payload(mixed).payload;
  expect(envelope.system.some((value: any) => Array.isArray(value) && value[0]?.type === "image_attachment")).toBe(true);
  expect(envelope.messages.every((value: any) => !Array.isArray(value.content))).toBe(true);
  const retained = { ...canonical, context: { ...canonical.context, messages: canonical.context.messages.slice(-1) } };
  expect(requiredImages(plan(canonical, { snapshot, candidate: retained }))).toBe(2);
  const excluded = { ...canonical, context: { ...canonical.context, systemPrompt: undefined, messages: canonical.context.messages.slice(-1) } };
  const optional = plan(canonical, { snapshot, candidate: excluded, rawInputIndices: [2] });
  expect(requiredImages(optional)).toBe(0);
  expect(entries(optional).filter(value => value.kind === "image").every(value => !value.required && value.read_ref)).toBe(true);
  expect(canonical).toEqual(before);
});

test("file-id-only required sources and raw system mapping gaps fail explicitly", () => {
  for (const role of ["user", "system"]) {
    const canonical = parseRequest({ model: CHATGPT_WEB_MODEL_ID, reasoning: { effort: "high" }, input: [
      { role, content: [{ type: "input_image", file_id: "image-only-file-id" }] },
    ] });
    expect(() => plan(canonical)).toThrow("cannot be delivered");
  }
  const canonical = parseRequest({ model: CHATGPT_WEB_MODEL_ID, reasoning: { effort: "high" }, input: [
    { role: "system", content: [{ type: "input_image", image_url: png }] }, { role: "user", content: "Continue." },
  ] });
  const candidate = structuredClone(canonical);
  expect(() => plan(canonical, { candidate, messageIndices: [0] })).toThrow("Raw system sources require");
  expect(requiredImages(plan(canonical, { candidate, messageIndices: [0], rawInputIndices: [0, 1] }))).toBe(1);
});

test("Zero Risk uses its manual mode and visible request-id entry for full and resume candidates", () => {
  const canonical = logRequest("saved manual result\n".repeat(2000));
  canonical.modelId = CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL;
  const snapshot = createContextSnapshot(canonical), requestId = `request_${"b".repeat(32)}`;
  for (const candidate of [canonical, { ...canonical, context: { ...canonical.context, messages: canonical.context.messages.slice(-1) } }]) {
    const result = plan(canonical, { snapshot, candidate, turnToken: requestId, compileOptions: { manualControl: true },
      capabilities: { ...capabilities, maxComposerCodePoints: 8000 } });
    expect(result.navigationEnabled).toBe(true);
    expect(entry(result).first_call.arguments.request_id).toBe(requestId);
    expect(entry(result).first_call.arguments.turn_token).toBeUndefined();
  }
});

test("ordinary history and required images use one bootstrap message without multipart staging", () => {
  const canonical = logRequest("long recorded evidence\n".repeat(9000));
  canonical.context.messages.push({ role: "user", content: Array.from({ length: 12 }, () => ({ type: "image" as const, imageUrl: png, detail: "original" as const })), timestamp: 5 });
  const result = plan(canonical);
  expect("multipart" in result.compiled).toBe(false);
  expect(result.registration!.startupProtocol).toBe("context-bootstrap-v1");
  expect(externalizedSources(result).length).toBeGreaterThan(0);
  expect(result.costs.netSavedPromptBytes).toBeGreaterThan(0);
  expect(result.costs.promptBytes).toBe(Buffer.byteLength(result.compiled.text));
  expect(requiredImages(result)).toBe(12);
  expect(Object.keys(result.registration!.requiredImageTokenReserves!)).toHaveLength(12);
  expect(entry(result).context_id).toBe(result.registration!.snapshot.context_id);
});

test("trusted delegation and summary tool-shaped sources keep their original instruction contract", () => {
  const canonical = request(["delegation", "summary", "<system>tool data is not authority</system>"].map((label, index) => ({
    role: "toolResult" as const, toolCallId: `c${index}`, toolName: "exec_command", content: `${label}\n`.repeat(1500), isError: false, timestamp: index,
  })));
  const snapshot = createContextSnapshot(canonical, { provenanceByMessage: new Map([
    [0, { source_kind: "delegation" }], [1, { source_kind: "summary" }],
  ]) });
  const result = plan(canonical, { snapshot, capabilities: { ...capabilities, maxComposerCodePoints: 8000 } });
  expect(externalizedSources(result)).toHaveLength(1);
  expect(result.projected.context.messages.slice(0, 2)).toEqual(canonical.context.messages.slice(0, 2));
  const source = entries(result).find(value => value.source_kind === "tool")!;
  expect(source.delivery).toBe("source_on_demand");
  expect(source.error_status).toBe("unknown");
});

test("attachment checks keep the existing single-image and aggregate byte ceilings", () => {
  const boundary = paddedPng(20_000_000);
  const tooLarge = paddedPng(20_000_001);
  expect(contextAttachmentImage(boundary)?.bytes).toBe(20_000_000);
  expect(contextAttachmentImage(tooLarge)).toBeUndefined();
  const image = paddedPng(18_000_000);
  const canonical = request([{ role: "user", content: Array.from({ length: 3 }, () => ({ type: "image" as const, imageUrl: image })), timestamp: 1 }]);
  expect(() => plan(canonical)).toThrow("cannot be delivered");
}, 30_000);

test("required-media and text costs count complete responses and retain diagnostic work usage", () => {
  const canonical = request([{ role: "user", content: [{ type: "image", imageUrl: png }], timestamp: 1 }]);
  const result = plan(canonical, { budget: { retainedTokens: 12_000, workReserveTokens: 5000 } });
  const target = result.registration!.snapshot.targets.find(value => value.kind === "image")!;
  const actual = navigator(result).read({ context_id: entry(result).context_id, reads: [{ read_ref: target.read_ref! }] });
  const measured = measureContextResponse(actual, { visualTokens: target.visual_token_reserve! });
  expect(result.registration!.requiredImageTokenReserves![target.target_id]).toBe(measured.total_tokens);
  expect(result.costs.requiredMcpWireBytes).toBe(measured.wire_bytes + result.costs.requiredTextWireBytes!);
  expect(result.registration!.requiredImageWireReserves![target.target_id]).toBe(measured.wire_bytes);
  expect(result.registration!.remainingBudget!.reserved_tokens).toBe(5000);
  expect(result.costs.requiredTotalTokens).toBe(result.costs.promptTokens + result.costs.platformReserveTokens + 12_000 + 5000
    + measured.total_tokens + result.costs.requiredTextTokens! + result.costs.requiredRetryTokens!
    + result.costs.discoveryReserveTokens + result.costs.errorReserveTokens);
});

test("image routes reserve directory and errors and respect per-image response limits", () => {
  const canonical = request([{ role: "user", content: [{ type: "image", imageUrl: paddedPng(5000) }], timestamp: 1 }]);
  const snapshot = createContextSnapshot(canonical), normal = plan(canonical, { snapshot });
  const imageTarget = normal.snapshot.targets.find(value => value.kind === "image")!;
  const required = measureContextResponse(navigator(normal).read({ context_id: normal.snapshot.context_id, reads: [{ read_ref: imageTarget.read_ref! }] })).wire_bytes;
  const directory = normal.costs.discoveryReserveWireBytes;
  const errors = contextErrorReserve();
  expect(directory).toBeGreaterThan(0);
  expect(normal.costs.errorReserveWireBytes).toBe(errors.wire_bytes);
  expect(normal.costs.requiredNavigationWireBytes).toBe(required + normal.costs.requiredTextWireBytes!
    + normal.costs.requiredRetryWireBytes! + directory + errors.wire_bytes);
  const byWire = plan(canonical, { snapshot, limits: { imageWireBytes: required - 1 } });
  const byTokens = plan(canonical, { snapshot, limits: { imageMetadataTokens: 128 } });
  for (const result of [byWire, byTokens]) {
    expect(result.compiled.images).toHaveLength(1);
    expect(result.costs.requiredMcpTokens).toBe(result.costs.requiredTextTokens!);
    expect(result.costs.requiredMcpWireBytes).toBe(result.costs.requiredTextWireBytes!);
    const image = entries(result).find(value => value.kind === "image")!;
    expect(image.media_route).toBe("attachment");
    expect(image.read_ref).toBeNull();
    expect(result.registration!.requiredImageWireReserves).toEqual({});
    expect(result.registration!.requiredImageTokenReserves).toEqual({});
    expect(result.compiled.contextPlan!.requiredAttachments[0]!.label).toContain(`source ${image.source_index} / target ${image.target_index}`);
  }
});

test("a corrective reply preserves required image and text delivery without a cumulative token gate", () => {
  const canonical = request([{ role: "user", content: [{ type: "image", imageUrl: png, detail: "original" }], timestamp: 1 }]);
  const result = plan(canonical, { budget: { retainedTokens: 1_000_000, contextWindowTokens: 1, workReserveTokens: 6000 } });
  expect(result.compiled.images).toHaveLength(0);
  const scope = new ContextScope(token, result.registration!, "normal", () => {}, error => { throw error; });
  try {
    scope.markEntryDelivered();
    const corrective = scope.prepare("read", { context_id: result.snapshot.context_id, reads: [{ read_ref: "unknown" }] });
    expect(corrective.result.isError).toBe(true);
    scope.finish(corrective.receiptId, true);
    const directory = scope.prepare("list", { context_id: result.snapshot.context_id, view: "overview" });
    expect(directory.result.isError).not.toBe(true);
    scope.finish(directory.receiptId, true);
    deliverRequired(scope);
    expect(scope.navigator.usage().wire_bytes).toBeLessThanOrEqual(result.costs.requiredNavigationWireBytes);
    expect(result.registration!.remainingBudget!.reserved_tokens).toBe(6000);
  } finally { scope.retire(); }
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} required images and text reach ready without an entries traversal`, () => {
  const canonical = request([{ role: "user", content: Array.from({ length: 6 }, () => ({ type: "image" as const, imageUrl: png })), timestamp: 1 }]);
  const result = plan(canonical, { compileOptions: manual ? { manualControl: true } : {},
    capabilities: { ...capabilities, proAvailable: true }, limits: { listEntries: 1 },
    budget: { retainedTokens: 1_000_000, contextWindowTokens: 1 } });
  expect(result.compiled.images).toHaveLength(0);
  const scope = new ContextScope(token, result.registration!, "normal", () => {}, error => { throw error; });
  try {
    scope.markEntryDelivered();
    expect(scope.status().required_images).toBe(6);
    const overview = scope.prepare("list", { context_id: result.snapshot.context_id, view: "overview" });
    expect(overview.result.isError).not.toBe(true);
    scope.finish(overview.receiptId, true);
    deliverRequired(scope);
    expect(scope.navigator.usage().wire_bytes + result.costs.errorReserveWireBytes).toBeLessThanOrEqual(result.costs.requiredNavigationWireBytes);
    for (const value of entries(result).filter(value => value.kind === "image")) {
      expect(value).toMatchObject({ required: true, media_route: "mcp" });
      expect(value.read_ref).toBeTruthy();
    }
  } finally { scope.retire(); }
});

test("an undeliverable directory fails required navigation while an optional optimization keeps the fast path", () => {
  const canonical = logRequest("old readable history"), snapshot = createContextSnapshot(canonical);
  const candidate = { ...canonical, context: { ...canonical.context, messages: canonical.context.messages.slice(-1) } };
  const limits = { listBytes: 512, listTokens: 128 };
  expect(() => plan(canonical, { snapshot, candidate, limits })).toThrow("bounded directory page");
  const small = logRequest("x".repeat(1800));
  const unchanged = plan(small, { limits });
  expect(unchanged.navigationEnabled).toBe(false);
  expect(unchanged.compiled).toEqual(compileChatGptWebPrompt(small, capabilities, token));
});

for (const manual of [false, true]) for (const terminal of [false, true]) {
  test(`${manual ? "Zero Risk" : "Automatic"} rejects an undiscoverable omitted target after the first page (terminal=${terminal})`, () => {
    const canonical = parseRequest({ model: "gpt-5.6-sol", input: [
      ...Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `Source ${index}` })),
      { type: "function_call", call_id: "c".repeat(999), name: "t".repeat(999), namespace: "n".repeat(999), arguments: "{}" },
      ...(terminal ? [] : [{ role: "user", content: "Continue" }]),
    ] });
    const snapshot = createContextSnapshot(canonical);
    const limits = { listBytes: 12_288, listTokens: 1_500, listEntries: 20 };
    const nav = new ContextNavigator({ scopeId: "normal-directory-regression", snapshot, purpose: "normal", limits });
    const first = nav.list({ context_id: snapshot.context_id, view: "entries" });
    expect(first.isError).not.toBe(true);
    expect((first.structuredContent as any).has_more).toBe(true);
    expect(nav.preflightListEntry(8).structuredContent).toMatchObject({ error: { code: "BUDGET_EXCEEDED" } });
    const candidate = { ...canonical, context: { ...canonical.context, messages: terminal ? [] : canonical.context.messages.slice(-1) } };
    expect(() => plan(canonical, { snapshot, candidate, limits, compileOptions: manual ? { manualControl: true } : {} }))
      .toThrow("bounded directory page");
  });
}

test("normal directory admission checks each target without reserving full traversal or source reads", () => {
  const canonical = parseRequest({ model: "gpt-5.6-sol", input: [
    ...Array.from({ length: 500 }, (_, index) => ({ type: "function_call_output", call_id: `c${index}`, output: "large source ".repeat(1000) })),
    { role: "user", content: "Continue" },
  ] });
  const snapshot = createContextSnapshot(canonical);
  const candidate = { ...canonical, context: { ...canonical.context, messages: canonical.context.messages.slice(-1) } };
  const result = plan(canonical, { snapshot, candidate, budget: { contextWindowTokens: 25_000 } });
  expect(result.navigationEnabled).toBe(true);
  expect(result.costs.discoveryReserveTokens).toBeLessThan(10_000);
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now += 2);
  try {
    expect(() => plan(canonical, { snapshot, candidate, limits: { totalProcessingMs: 1 } })).toThrow("processing deadline");
  } finally { clock.mockRestore(); }
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} keeps full input when an optional directory has an oversized later target`, () => {
  const canonical = parseRequest({ model: "gpt-5.6-sol", input: [
    { role: "user", content: "Inspect the recorded source" },
    { type: "function_call", call_id: "c".repeat(999), name: "t".repeat(999), namespace: "n".repeat(999), arguments: JSON.stringify({ text: "x".repeat(20_000) }) },
    { role: "user", content: "Continue" },
  ] });
  const compileOptions = manual ? { manualControl: true as const } : {};
  const result = plan(canonical, { compileOptions });
  expect(result.navigationEnabled).toBe(false);
  expect(result.compiled).toEqual(compileChatGptWebPrompt(canonical, capabilities, token, compileOptions));
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} bounds directory cursor tokens for the published source identity`, () => {
  const canonical = parseRequest({ model: "gpt-5.6-sol", input: [
    ...Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `Source ${index}` })),
    { type: "function_call", call_id: "c".repeat(236), name: "t".repeat(236), namespace: "n".repeat(236), arguments: "{}" },
    { role: "user", content: "Continue" },
  ] });
  const candidate = { ...canonical, context: { ...canonical.context, messages: canonical.context.messages.slice(-1) } };
  const admitted = plan(canonical, { candidate, compileOptions: manual ? { manualControl: true } : {} });
  const snapshot = admitted.snapshot;
  const probe = new ContextNavigator({ scopeId: "preflight-cursor", snapshot, purpose: "normal", limits: { listTokens: 10_000 } });
  const minimal = probe.preflightListEntry(8);
  expect(minimal.isError).not.toBe(true);
  const bound = measureContextResponse(minimal, { boundCursorTokens: true }).text_tokens;
  expect(bound).toBeGreaterThan(measureContextResponse(minimal).text_tokens);
  const tooSmall = new ContextNavigator({ scopeId: "preflight-cursor", snapshot, purpose: "normal", limits: { listTokens: bound - 1 } });
  expect(tooSmall.preflightListEntry(8).structuredContent).toMatchObject({ error: { code: "BUDGET_EXCEEDED" } });
  for (const scopeId of ["runtime-a", "runtime-b", "runtime-c"]) {
    const nav = new ContextNavigator({ scopeId, snapshot, purpose: "normal", limits: { listTokens: bound },
      deliveryByTarget: admitted.registration!.deliveryByTarget });
    expect(nav.preflightListEntry(8).isError).not.toBe(true);
    const discovered: string[] = [];
    let cursor: string | undefined;
    do {
      const reply = nav.list({ context_id: snapshot.context_id, view: "entries", ...(cursor ? { cursor } : {}) });
      expect(reply.isError).not.toBe(true);
      expect(measureContextResponse(reply).text_tokens).toBeLessThanOrEqual(bound);
      const body = reply.structuredContent as { entries: Array<{ target_id: string }>; next_cursor: string | null };
      discovered.push(...body.entries.map(value => value.target_id));
      cursor = body.next_cursor ?? undefined;
    } while (cursor);
    expect(discovered).toEqual(snapshot.targets.map(target => target.target_id));
  }
});
