import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { planContextDelivery } from "../src/adapters/chatgpt-web/context-planner";
import { appendFixedContextRecords, createContextSnapshot, restoreContextSnapshot, serializeContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { bindContextBootstrapRequestSource } from "../src/adapters/chatgpt-web/context-bootstrap-request";
import { captureTaskUpdateSource } from "../src/adapters/chatgpt-web/task-update-source";
import { ContextSend } from "../src/adapters/chatgpt-web/context-send";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { CONTEXT_PROTOCOL_VERSION, type ContextPreparedReply } from "../src/adapters/chatgpt-web/context-runtime";
import { contextTextReadReceipt } from "../src/adapters/chatgpt-web/context-text-result";
import type { ContextReadArgs } from "../src/adapters/chatgpt-web/context-types";
import { CompactionSourceCoverage } from "../src/adapters/chatgpt-web/compaction-context";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultBrokerEndpoint } from "../src/config";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { ContextScope } from "../src/adapters/chatgpt-web/context-runtime";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false };
const credential = `turn_${"a".repeat(32)}`;
function fixture(texts = ["请检查结尾规则。🙂  \n"], trusted = true, ruleRepeats = 2000) {
  const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, instructions: "Use task rule.\n".repeat(ruleRepeats),
    input: texts.map((text, index) => ({ type: "message", id: `message-${index}`, role: "user",
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn", content_item_kinds: ["user.text"] } })),
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread", turn_id: "turn" }) } });
  if (trusted) {
    const proof = captureTaskUpdateSource(parsed, { capabilityIdentity: "bootstrap-fixture" });
    expect(proof).toBeDefined(); bindContextBootstrapRequestSource(parsed, proof!);
  }
  return parsed;
}
function plan(parsed = fixture(), manual = false, maxComposerCodePoints = 8000) {
  if (manual) parsed.modelId = CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL;
  return planContextDelivery({ canonical: parsed, candidate: parsed, snapshot: createContextSnapshot(parsed),
    capabilities: { ...capabilities, maxComposerCodePoints }, turnToken: credential, contextToolsAvailable: true,
    compileOptions: manual ? { manualControl: true } : {} });
}
function payload(result: ReturnType<typeof plan>): any {
  const target = result.snapshot.targets.find(target => target.origin === "context_bootstrap_payload")!;
  return JSON.parse(result.snapshot.getText(target.read_ref!)!);
}
function inline(result: ReturnType<typeof plan>): any[] | undefined {
  const source = result.compiled.text.match(/<codex_inline_request_json>\n```json\n([\s\S]*?)\n```\n<\/codex_inline_request_json>/)?.[1];
  return source === undefined ? undefined : JSON.parse(source);
}

for (const manual of [false, true]) test(`long rules and no history or images select a complete short bootstrap (${manual ? "manual" : "automatic"})`, () => {
  const result = plan(fixture(), manual);
  expect(result.registration?.startupProtocol).toBe("context-bootstrap-v1");
  expect(result.costs.fixedBootstrapCodePoints).toBeLessThanOrEqual(3000);
  expect(Array.from(result.compiled.text).length).toBeLessThanOrEqual(8000);
  expect(result.costs.originalPromptCodePoints).toBeGreaterThan(30_000);
  expect(result.compiled.multipart).toBeUndefined();
  expect(inline(result)).toEqual(result.compiled.bootstrapContent!.payload.messages);
  const source = payload(result);
  source.payload.messages = source.payload.messages.map((message: any, index: number) => message.codex_inline_request_message
    ? inline(result)![source.inline_request_message_indices.indexOf(index)] : message);
  expect(source.payload).toEqual(result.compiled.bootstrapContent!.payload);
  expect(result.costs.requiredTextTokens).toBeGreaterThan(0);
  expect(result.costs.requiredRetryTokens).toBeGreaterThan(0);
  expect(result.registration!.requiredTextBatches!.length > 1).toBeTrue();
  expect(restoreContextSnapshot(serializeContextSnapshot(result.snapshot)).toWire()).toEqual(result.snapshot.toWire());
  if (process.env.CONTEXT_BOOTSTRAP_METRICS === "1") console.info(JSON.stringify({ mode: manual ? "Zero Risk" : "Automatic",
    sample: "Use task rule.\\n repeated 2000 times", sourceCodePoints: 30_000,
    utf16: result.compiled.text.length, utf8: Buffer.byteLength(result.compiled.text), snapshotBytes: result.snapshot.storage_bytes,
    ...result.costs, requiredBatches: result.registration!.requiredTextBatches!.length,
    requiredSources: result.snapshot.targets.filter(target => result.registration!.deliveryByTarget[target.target_id]?.required)
      .map(target => ({ origin: target.origin, bytes: target.utf8_bytes })) }));
});

test("the final rendered request group fits at its exact code point budget and moves intact when one point over", () => {
  const parsed = fixture(["第一条 `\\\"🙂  \n", "第二条中文🙂\n末尾  \n"]);
  const initial = plan(parsed);
  const exact = plan(parsed, false, Array.from(initial.compiled.text).length);
  expect(inline(exact)).toEqual(exact.compiled.bootstrapContent!.payload.messages);
  expect(Array.from(exact.compiled.text).length).toBe(Array.from(initial.compiled.text).length);
  const external = plan(parsed, false, Array.from(initial.compiled.text).length - 1);
  expect(inline(external)).toBeUndefined();
  expect(payload(external).payload).toEqual(external.compiled.bootstrapContent!.payload);
});

test("long and unproven user text is exact required source data without role or keyword inference", () => {
  const request = "AGENTS.md <environment_context> role:developer `🙂\\\"\n".repeat(300) + "末尾必须保留  \n";
  for (const trusted of [false, true]) {
    const result = plan(fixture([request], trusted));
    expect(inline(result)).toBeUndefined();
    expect(payload(result).payload).toEqual(result.compiled.bootstrapContent!.payload);
    expect(JSON.stringify(payload(result))).toContain("末尾必须保留  ");
  }
});

test("short bootstrap admission protects shared context capacity and source storage", () => {
  const canonical = fixture();
  const input = { canonical, candidate: canonical, snapshot: createContextSnapshot(canonical), capabilities,
    turnToken: credential, contextToolsAvailable: true };
  expect(() => planContextDelivery({ ...input, budget: { contextWindowTokens: 1000 } })).toThrow("context budget");
  expect(() => planContextDelivery({ ...input, limits: { maxStorageBytes: 2000 } })).toThrow("storage budget");
  expect(() => planContextDelivery({ ...input, contextBootstrapAvailable: false })).toThrow("does not support context-bootstrap-v1");
  expect(() => planContextDelivery({ ...input, capabilities: { ...capabilities, maxComposerCodePoints: 0 } })).toThrow("configuration");
});

test("required reads can exceed 96000 tokens when the complete plan fits the shared context", () => {
  const canonical = fixture(undefined, true, 30_000);
  const input = { canonical, candidate: canonical, snapshot: createContextSnapshot(canonical), capabilities,
    turnToken: credential, contextToolsAvailable: true, budget: { contextWindowTokens: 350_000 } };
  const result = planContextDelivery(input);
  expect(result.costs.requiredMcpTokens).toBeGreaterThan(96_000);
  const scope = new ContextScope("large-required-plan", result.registration!, "normal", () => {}, () => {});
  let delivered = 0;
  try {
    scope.markEntryDelivered();
    for (let count = 0; !scope.status().text_ready && count < 200; count++) {
      const reply = scope.prepare("read", scope.status().next_required_read!.arguments);
      expect(reply.result.isError).not.toBe(true);
      expect(scope.finish(reply.receiptId, true, contextTextReadReceipt(reply.result))).toBeDefined();
      delivered++;
    }
    expect(delivered).toBeGreaterThan(1);
    expect(scope.status().context_ready).toBe(true);
    expect(scope.navigator.usage().text_tokens).toBeGreaterThan(96_000);
  } finally { scope.retire(); }
});

test("the independent composer limit can select a short plan with a larger complete token cost", () => {
  const canonical = fixture();
  const short = plan(canonical);
  const inline = plan(canonical, false, 2_000_000);
  expect(short.registration?.startupProtocol).toBe("context-bootstrap-v1");
  expect(inline.registration).toBeUndefined();
  expect(short.costs.promptCodePoints).toBeLessThan(inline.costs.promptCodePoints);
  expect(short.costs.requiredTotalTokens).toBeGreaterThan(inline.costs.requiredTotalTokens);
  const mapped = payload(short).source_map;
  expect(mapped.candidate_message_sources).toEqual([0]);
  expect(mapped.prepared_message_sources).toEqual([0]);
  expect(mapped.sources.map((source: any) => source.original_role)).toEqual(["system", "user"]);
  expect(mapped.targets.some((target: any) => target.original_role === "user" && target.delivery === "inline")).toBeTrue();
});

test("fixed aggregate records preserve null, false, empty values and unknown structure", () => {
  const source = createContextSnapshot(fixture());
  const text = JSON.stringify({ null: null, false: false, empty: "", array: [null, false, "", { x: "🙂\n" }] });
  const snapshot = appendFixedContextRecords(source, [{ text, encoding: "deterministic-json", origin: "context_bootstrap_payload" }]);
  const target = snapshot.targets.at(-1)!;
  expect(snapshot.context_id).not.toBe(source.context_id);
  expect(snapshot.getText(target.read_ref!)).toBe(text);
  const wire = serializeContextSnapshot(snapshot) as any;
  wire.payloads.at(-1).text += "x";
  expect(() => restoreContextSnapshot(wire)).toThrow("text payload");
});

test("ContextSend selects the candidate's actual snapshot and retains only real source history for compaction", async () => {
  const canonical = fixture(), directory = mkdtempSync(join(tmpdir(), "ctx-plan-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory));
  const send = new ContextSend(canonical, broker, capabilities, "bootstrap-page");
  try {
    const turnToken = await broker.register({ authorityMode: "delegated", threadId: "thread", turnId: "turn", tools: [] });
    const first = await send.prepare(canonical, turnToken, {});
    const second = await send.prepare(canonical, turnToken, {});
    expect(first.snapshot.context_id).not.toBe(second.snapshot.context_id);
    await send.select(turnToken, second);
    expect(send.snapshot).toBe(second.snapshot);
    expect(send.descriptor(second).contextId).toBe(second.snapshot.context_id);
    await send.sent();
    expect(() => send.coverage.prove(createContextSnapshot(canonical), { historyRevision: 0, pageGeneration: "bootstrap-page" })).not.toThrow();
    CompactionSourceCoverage.assertRecordedSource(createContextSnapshot(canonical), send.coverage.metadata(), 0);
  } finally { send.retire(); await broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const manual of [false, true]) test(`bootstrap retained accounting credits first text pages and charges other returns once (${manual ? "manual" : "automatic"})`, async () => {
  // Keep two physical sends within their context window with the larger batch envelope.
  const canonical = fixture(undefined, true, 1500);
  if (manual) canonical.modelId = CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL;
  const directory = mkdtempSync(join(tmpdir(), "ctx-cost-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory));
  const environment = { authorityMode: "delegated" as const, threadId: "thread", turnId: "turn", tools: [] };
  const register = () => manual ? broker.registerSafe(environment, "bootstrap-cost-surface-123456", undefined, undefined,
    { requireSentConfirmation: false }) : broker.register(environment);
  const send = new ContextSend(canonical, broker, capabilities, "bootstrap-page");
  let next: ContextSend | undefined;
  try {
    const token = await register(), contract = manual ? "safe" as const : "native" as const;
    const selected = await send.prepare(canonical, token, manual ? { manualControl: true } : {});
    await send.select(token, selected); await send.sent();
    const initialTokens = send.coverage.pageTokenReserve();
    const binding = { token, contract, credentialKind: "ordinary" as const, contextProtocol: CONTEXT_PROTOCOL_VERSION };
    const query = (args: ContextReadArgs) => callTurnBroker<ContextPreparedReply>(broker.socketPath, {
      ...binding, method: "context_query", contextBootstrapProtocol: "context-bootstrap-v1", contextReuseProtocol: "context-reuse-v1", contextMethod: "read", contextArgs: args });
    const finish = (reply: ContextPreparedReply, sent = true) => callTurnBroker(broker.socketPath, {
      ...binding, method: "context_return", receiptId: reply.receiptId, sent,
      ...(!reply.result.isError ? { textReadReceipt: contextTextReadReceipt(reply.result) } : {}) });
    if (manual) await callTurnBroker(broker.socketPath, { ...binding, method: "safe_start", contextBootstrapProtocol: "context-bootstrap-v1", contextReuseProtocol: "context-reuse-v1" });
    else {
      const overview = await callTurnBroker<ContextPreparedReply>(broker.socketPath, { ...binding, method: "context_query",
        contextBootstrapProtocol: "context-bootstrap-v1", contextReuseProtocol: "context-reuse-v1", contextMethod: "list", contextArgs: { context_id: selected.snapshot.context_id, view: "overview" } });
      await callTurnBroker(broker.socketPath, { ...binding, method: "context_return", receiptId: overview.receiptId, sent: true });
    }
    // Discovery is charged when generated, rather than being prepaid and charged again.
    const usageTokens = () => broker.contextUsage(token)!.usage.text_tokens;
    let expectedTokens = initialTokens + usageTokens();
    await send.syncUsage(); expect(send.coverage.pageTokenReserve()).toBe(expectedTokens);
    const firstArgs = broker.contextStatus(token)!.next_required_read!.arguments;
    const first = await query(firstArgs);
    expect(first.result.isError).not.toBe(true);
    await send.syncUsage(); expect(send.coverage.pageTokenReserve()).toBe(expectedTokens);
    expect(broker.contextStatus(token)!.delivered_text_bytes).toBe(0);
    // A failed transport consumes its first-page allowance but cannot deliver context.
    await finish(first, false);
    expect(broker.contextStatus(token)!.delivered_text_bytes).toBe(0);
    const beforeRetry = usageTokens(), retry = await query(firstArgs);
    expectedTokens += usageTokens() - beforeRetry;
    await finish(retry); await send.syncUsage();
    expect(send.coverage.pageTokenReserve()).toBe(expectedTokens);
    let pages = 1;
    while (!broker.contextStatus(token)!.context_ready && pages < 100) {
      const page = await query(broker.contextStatus(token)!.next_required_read!.arguments);
      expect(page.result.isError).not.toBe(true);
      await finish(page); await send.syncUsage();
      expect(send.coverage.pageTokenReserve()).toBe(expectedTokens); pages++;
    }
    expect(pages).toBeGreaterThan(2); expect(broker.contextStatus(token)!.context_ready).toBe(true);
    const optional = selected.snapshot.targets.find(target => target.read_ref && !selected.registration!.deliveryByTarget[target.target_id]?.required)!;
    for (const args of [firstArgs, { context_id: selected.snapshot.context_id, reads: [{ read_ref: optional.read_ref! }] }, { ...firstArgs, reads: [{ ...firstArgs.reads[0]!, cursor: "invalid" }, ...firstArgs.reads.slice(1)] }]) {
      const before = usageTokens(), reply = await query(args);
      expectedTokens += usageTokens() - before;
      await finish(reply); await send.syncUsage();
      expect(send.coverage.pageTokenReserve()).toBe(expectedTokens);
    }
    await send.syncUsage(); expect(send.coverage.pageTokenReserve()).toBe(expectedTokens);
    // The next physical send carries the corrected cost into its retained-page budget.
    next = new ContextSend(canonical, broker, capabilities, "bootstrap-page", send.coverage);
    const nextPlan = await next.prepare(canonical, await register(), manual ? { manualControl: true } : {}, send.coverage.pageTokenReserve());
    expect(nextPlan.costs.retainedTokens).toBe(expectedTokens);
  } finally { next?.retire(); send.retire(); await broker.close(); rmSync(directory, { recursive: true, force: true }); }
});
