import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { CONTINUITY_FEATURE, type ContinuityLease } from "../src/adapters/chatgpt-web/continuity-contract";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnExecutionKey, chatGptTurnSessions, TASK_UPDATE_SESSION_JOURNAL_BYTES } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { NativeOperationReply } from "../src/adapters/chatgpt-web/native-tool-operations";
import type { UpdateDelivery } from "../src/adapters/chatgpt-web/task-update-protocol";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { defaultBrokerEndpoint } from "../src/config";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { chatGptTurnSessions.clear(); for (const action of cleanup.splice(0).reverse()) await action(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function user(id: string, content = id): Record<string, unknown> {
  return { type: "message", role: "user", id, content,
    internal_chat_message_metadata_passthrough: { turn_id: "turn", content_item_kinds: ["user.text"] } };
}
const output = (id: string, text = "first result") => ({ type: "function_call_output", call_id: id, output: text });
function resultStorage(session: ReturnType<Awaited<ReturnType<typeof fixture>>["session"]>) {
  // Inspect the retained bodies and the authoritative storage ledger, independently of heap GC.
  return session as unknown as { continuityReceivedResults: Map<string, unknown>;
    continuityReceivedResultBytes: number; taskUpdateStorageBytes(): number };
}

async function fixture(manual = false, protocol = true, search = false) {
  const root = mkdtempSync("/tmp/cgw-cont-update-");
  const pages = new Map<string, { continuity: ContinuityLease; state: "ready" | "running" }>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("continuity-capacity")) return Response.json({ ok: true, available: true });
    const body = await request.json() as { conversationKey: string; expected: ContinuityLease };
    const page = pages.get(body.conversationKey);
    if (new URL(request.url).pathname.endsWith("release")) { pages.delete(body.conversationKey); return Response.json({ ok: true, released: 1 }); }
    return page && JSON.stringify(page.continuity) === JSON.stringify(body.expected)
      ? Response.json({ ok: true, ...page }) : Response.json({ ok: false }, { status: 409 });
  } });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development",
    pid: process.pid, features: [CONTINUITY_FEATURE], endpoint: `http://127.0.0.1:${server.port}`,
    control: { endpoint: `http://127.0.0.1:${server.port}`, token: "a".repeat(43) },
    helper: { executable: process.execPath, script: import.meta.path }, partition: "persist:codex-web-gpt-dev-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString() }), { mode: 0o600 });
  const statePath = join(root, "state");
  new ContinuityRegistrationStore(statePath).initialize();
  const socket = defaultBrokerEndpoint(root);
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `fixture://${root}`, chatgptWeb: {
    browserHost: "launcher", browserHostDescriptorPath: descriptorPath, continuityStateDirectory: statePath,
    browserInteractionMode: manual ? "manual" : "automatic", brokerSocketPath: socket,
    localToolsEnabled: true, toolAuthorityMode: "delegated", solAvailable: !manual, zeroRiskRequireSentConfirmation: true,
  } };
  const broker = TurnBroker.forSocket(socket);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const compatible = spyOn(worker, "assertContinuityCompatible").mockResolvedValue();
  const supported = spyOn(worker, "supportsTaskUpdates").mockResolvedValue(protocol);
  const ready = deferred<{ token: string; turn?: BrowserTurn }>();
  const answer = deferred<string>();
  let submissions = 0;
  let physicalKey = "";
  let token = "";
  const runWorker = spyOn(worker, "run").mockImplementation(async turn => {
    submissions++;
    physicalKey = turn.conversationKey!;
    const lease = { owner: turn.continuity!.owner, leaseId: "1".repeat(32), traceId: turn.traceId };
    pages.set(physicalKey, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    const compiled = await turn.prepare();
    if (turn.nativeConnector) {
      const control = compiled.text.match(/turn_token (control_[a-f0-9]{32})/)![1]!;
      const handoffId = compiled.text.match(/handoff_id (handoff_[a-f0-9]{32})/)![1]!;
      const aborted = new Promise<void>(resolve => turn.abortSignal!.addEventListener("abort", () => resolve(), { once: true }));
      await callTurnBroker(socket, { method: "submit_compaction_handoff", token: control, handoffId, summary: "Current appended work checkpoint." });
      await aborted;
      pages.get(physicalKey)!.state = "ready";
      return "";
    }
    token = compiled.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)![1]!;
    await turn.onSubmitted?.();
    void (async () => {
      let revision = 0;
      while (!turn.abortSignal?.aborted) {
        const progress = await turn.externalProgress!.waitForChange(revision, turn.abortSignal);
        revision = progress.revision;
        if (progress.lastToolBatchRevision) await turn.externalProgress!.acknowledgeToolBatch(progress.lastToolBatchRevision);
      }
    })().catch(() => {});
    ready.resolve({ token, turn });
    return new Promise<string>((resolve, reject) => {
      turn.abortSignal?.addEventListener("abort", () => reject(turn.abortSignal!.reason), { once: true });
      answer.promise.then(value => { pages.get(physicalKey)!.state = "ready"; resolve(value); });
    });
  });
  const manualControl: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      submissions++;
      physicalKey = activity.conversationKey!;
      const continuity = { owner: activity.continuity!.owner, leaseId: "1".repeat(32), traceId: activity.traceId };
      pages.set(physicalKey, { continuity, state: "running" });
      token = JSON.parse(activity.prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)\n/)![1]!).request_id;
      return { continuity };
    },
    async waitSent() { broker.startSafeTurn(token); },
    waitTerminal: () => new Promise<never>(() => {}),
    async markStarted() { ready.resolve({ token }); },
    async end() { const page = pages.get(physicalKey); if (page) page.state = "ready"; },
    async cancel() {},
  };
  const originalAccept = broker.acceptTaskUpdate;
  if (!protocol) broker.acceptTaskUpdate = undefined as never;
  const adapter = createChatGptWebAdapter(provider, { broker, zeroRiskManualControl: manualControl });
  const request = (input: unknown[] = [user("initial-user", "Inspect the project.")], requestId = "request") => {
    const parsed = parseRequest({ model: manual ? CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL : "gpt-5.6-sol",
      stream: false, input, tools: [{ type: "function", name: "exec_command", description: "Simulated tool",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
      ...(search ? [{ type: "tool_search", description: "Simulated discovery", parameters: { type: "object" } }] : [])],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: root, turn_id: "turn", request_id: requestId }) } });
    parsed._conversationPolicy = "continuity-first";
    return parsed;
  };
  const initial = request();
  const run = async (parsed: CodexParsedRequest, events: AdapterEvent[] = [], signal?: AbortSignal) => {
    await adapter.preflight!(parsed, { headers: new Headers(), abortSignal: signal });
    await adapter.runTurn!(parsed, { headers: new Headers(), abortSignal: signal }, event => events.push(event));
    return events;
  };
  const contract = manual ? "safe" : "native";
  const start = (operationId: number, taskRevision = 0) => callTurnBroker<NativeOperationReply & { taskUpdate?: UpdateDelivery }>(socket, {
    method: "native_operation_start", token, contract, nativeWaitProtocol: 1, ...(protocol ? { taskUpdateProtocol: 1, taskRevision } : {}),
    operationId, entry: "codex_exec", nativeInput: { cmd: "simulated only" }, waitMs: 1,
  });
  const wait = (operationId: number) => callTurnBroker<NativeOperationReply & { taskUpdate?: UpdateDelivery }>(socket, {
    method: "native_operation_wait", token, contract, nativeWaitProtocol: 1, operationId, waitMs: 1,
  });
  const startTool = (operationId: number, wireName: string, taskRevision = 0) => callTurnBroker<NativeOperationReply & { taskUpdate?: UpdateDelivery }>(socket, {
    method: "native_operation_start", token, contract, nativeWaitProtocol: 1, taskUpdateProtocol: 1, taskRevision,
    operationId, entry: "codex_tool_call", nativeInput: { wire_name: wireName, arguments: {} }, waitMs: 1,
  });
  const ack = (delivery: UpdateDelivery) => broker.acknowledgeTaskUpdate(token, delivery.deliveryId, delivery.throughRevision, contract);
  const session = () => chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(initial)}`)!;
  const finish = async () => {
    const state = broker.taskUpdateState(token);
    if (manual) broker.completeSafeTurn(token, "Completed with the appended instruction.", state?.acceptedRevision);
    else {
      const { turn } = await ready.promise;
      const context = state ? { expectedDriverGeneration: state.driverGeneration,
        taskRevision: state.acceptedRevision, acknowledgedRevision: state.acknowledgedRevision } : undefined;
      turn!.onTextDelta("Completed with the appended instruction.", context);
      const fence = await turn!.completionFence!.begin(context);
      if (fence !== undefined) expect(await turn!.completionFence!.commit(fence, context)).toBeTrue();
      answer.resolve("Completed with the appended instruction.");
    }
  };
  cleanup.push(async () => {
    broker.acceptTaskUpdate = originalAccept;
    compatible.mockRestore(); supported.mockRestore(); runWorker.mockRestore();
    await broker.close(); await server.stop(true); rmSync(root, { recursive: true, force: true });
  });
  return { initial, request, run, ready: ready.promise, start, wait, ack, finish, session, broker,
    pages, provider, adapter, startTool, socket, submissions: () => submissions, token: () => token };
}

async function batch(f: Awaited<ReturnType<typeof fixture>>, count = 1) {
  const events: AdapterEvent[] = [];
  const running = f.run(f.initial, events);
  await f.ready;
  const starts = Array.from({ length: count }, (_, index) => f.start(index + 1));
  await Promise.all(starts);
  await running;
  return events.filter((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
}

for (const manual of [false, true]) test(`A1 continuity ${manual ? "Zero Risk" : "Automatic"} appends at the current Native result boundary`, async () => {
  const f = await fixture(manual);
  const [call] = await batch(f);
  const physical = f.session();
  const binding = physical.runtime.continuityBinding!;
  const physicalExecution = binding.executionKey;
  const incoming = f.request([user("initial-user", "Inspect the project."), output(call!.id), user("append", "Also inspect tests.")]);
  const running = f.run(incoming);
  const result = await f.wait(1);
  // A short Native wait can precede the adapter commit. Query until that real result is available.
  let delivered = result;
  while (delivered.kind !== "result") delivered = await f.wait(1);
  expect(delivered.taskUpdate?.updates.map(update => update.content)).toEqual(["Also inspect tests."]);
  f.ack(delivered.taskUpdate!);
  await f.finish();
  expect((await running).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.session()).toBe(physical);
  expect(binding.executionKey).toBe(physicalExecution);
  expect(binding.logicalExecutionKey).toBe(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(incoming)}`);
  expect(binding.revision).toBe(0);
  expect(physical.taskRevision()).toBe(1);
  expect(physical.driverGeneration()).toBe(1);
  expect(f.submissions()).toBe(1);
  expect(f.pages.size).toBe(1);
});

test("A2-A4 continuity accepts trimmed history, first results, partial batches and a new transport request ID", async () => {
  const f = await fixture();
  const calls = await batch(f, 2);
  const accept = f.broker.acceptTaskUpdate.bind(f.broker);
  let lostReceipt = false;
  f.broker.acceptTaskUpdate = (token, transfer) => {
    const result = accept(token, transfer);
    if (!lostReceipt && result.status === "committed") { lostReceipt = true; throw new Error("Commit receipt lost"); }
    return result;
  };
  const first = f.request([output(calls[0]!.id), user("append", "Keep the first result."), output("unknown", "ignored")]);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  expect(f.session().outstanding()).toHaveLength(1);
  const reply = await f.wait(1);
  expect(reply.kind).toBe("result");
  const retry = f.request([{ ...output(calls[0]!.id, "different retry body"), type: "custom_tool_call_output" },
    output("history", "changed history"), user("append", "Keep the first result.")], "new-transport-request");
  await f.run(retry);
  expect(f.session().taskRevision()).toBe(1);
  expect(f.session().driverGeneration()).toBe(1);
  expect(reply.kind === "result" && reply.result.content).toEqual([{ type: "text", text: "first result" }]);
  expect(f.session().continuityReceivedToolResult(calls[0]!.id)).toBeUndefined();
  f.ack(reply.taskUpdate!);
  const supplement = f.request([output(calls[1]!.id), output(calls[0]!.id, "repeated")]);
  const running = f.run(supplement);
  let finalResult = await f.wait(2);
  while (finalResult.kind !== "result") finalResult = await f.wait(2);
  await f.finish();
  await running;
  expect(f.session().taskRevision()).toBe(1);
  expect(f.session().driverGeneration()).toBe(1);
  expect(f.session().outstanding()).toEqual([]);
  expect(f.submissions()).toBe(1);
});

test("continuity reclaims three 12 MiB results after delivery and does not restore raw bodies on journal replay", async () => {
  const f = await fixture();
  const calls = await batch(f, 3);
  const large = "x".repeat(12 * 1024 * 1024);
  const largeOutput = (id: string) => ({ ...output(id), _meta: { raw: large } });
  const first = f.request([largeOutput(calls[0]!.id), user("append", "Deliver the results in separate requests.")]);
  await f.run(first);
  const reply = await f.wait(1);
  expect(reply.kind).toBe("result");
  f.ack(reply.taskUpdate!);
  const storage = resultStorage(f.session());
  expect(storage.continuityReceivedResults.size).toBe(0);
  await f.run(f.request([largeOutput(calls[1]!.id)]));
  expect(storage.continuityReceivedResults.size).toBe(0);
  await f.run(first);
  await f.run(f.request([output(calls[0]!.id, "different completed body")], "new-repeat"));
  expect(storage.continuityReceivedResults.size).toBe(0);
  const running = f.run(f.request([largeOutput(calls[2]!.id)]));
  let last = await f.wait(3);
  while (last.kind !== "result") last = await f.wait(3);
  await f.finish(); await running;
  expect(storage.continuityReceivedResults.size).toBe(0);
  expect(storage.continuityReceivedResultBytes).toBe(0);
  expect(storage.taskUpdateStorageBytes()).toBeLessThanOrEqual(TASK_UPDATE_SESSION_JOURNAL_BYTES);
  const retained = f.session().continuityToolResultReplayEvidence(f.request([user("append", "Deliver the results in separate requests.")]));
  expect(retained.results.map(result => result.callId)).toEqual(calls.map(call => call.id));
  expect(JSON.stringify(retained).length).toBeLessThan(1_000);
}, 15_000);

test("continuity budgets undelivered first results atomically and releases capacity only on confirmed delivery", async () => {
  const f = await fixture();
  const calls = await batch(f, 3);
  await f.run(f.request([user("append", "Receive results when available.")]));
  const delivery = await f.wait(1);
  f.ack(delivery.taskUpdate!);
  const session = f.session();
  const storage = resultStorage(session);
  const large = "x".repeat(12 * 1024 * 1024);
  const largeOutput = (id: string) => ({ ...output(id), _meta: { raw: large } });
  const oversized = f.request(calls.map(call => largeOutput(call.id)));
  expect(() => { session.acceptContinuityToolResults(oversized); }).toThrow("capacity");
  expect(storage.continuityReceivedResults.size).toBe(0);
  const before = storage.taskUpdateStorageBytes();
  session.acceptContinuityToolResults(f.request(calls.slice(0, 2).map(call => largeOutput(call.id))));
  expect(storage.continuityReceivedResults.size).toBe(2);
  expect(storage.continuityReceivedResultBytes).toBeGreaterThan(24 * 1024 * 1024);
  expect(storage.taskUpdateStorageBytes() - before).toBe(storage.continuityReceivedResultBytes);
  const acceptedBytes = storage.continuityReceivedResultBytes;
  expect(() => { session.acceptContinuityToolResults(f.request([largeOutput(calls[2]!.id)])); }).toThrow("capacity");
  expect(storage.continuityReceivedResultBytes).toBe(acceptedBytes);
  expect(session.outstanding()).toHaveLength(3);
  const context = { expectedDriverGeneration: 1, taskRevision: 1, acknowledgedRevision: 1 };
  await f.broker.completeTool(f.token(), calls[0]!.id,
    { content: [{ type: "text", text: "first result" }], _meta: { raw: large } }, context);
  if (session.runtime.mode !== "tools") throw new Error("The fixture must retain local tool authority.");
  session.runtime.externalProgress.recordToolResult();
  session.markResultDelivered(calls[0]!.id);
  expect(storage.continuityReceivedResults.size).toBe(1);
  expect(storage.continuityReceivedResultBytes).toBe(acceptedBytes / 2);
  // Partial delivery releases the successful member only. An interrupted next member
  // keeps its exact first payload even when the next request echoes another body.
  const failedDelivery = spyOn(f.broker, "completeTool").mockImplementationOnce(async () => { throw new Error("Delivery interrupted"); });
  await expect(f.broker.completeTool(f.token(), calls[1]!.id, { content: [] }, context)).rejects.toThrow("Delivery interrupted");
  failedDelivery.mockRestore();
  expect((session.continuityReceivedToolResult(calls[1]!.id)?._meta as { raw: string }).raw.length).toBe(large.length);
  await f.run(f.request([output(calls[0]!.id, "completed repeat"), output(calls[1]!.id, "changed retry")], "retry-second"));
  const first = await f.wait(1);
  expect(first.kind === "result" && first.result.content).toEqual([{ type: "text", text: "first result" }]);
  expect(first.kind === "result" && (first.result._meta as { raw: string }).raw.length).toBe(large.length);
  expect(session.continuityReceivedToolResult(calls[0]!.id)).toBeUndefined();
  const second = await f.wait(2);
  expect(second.kind === "result" && second.result.content).toEqual([{ type: "text", text: "first result" }]);
  expect(second.kind === "result" && (second.result._meta as { raw: string }).raw.length).toBe(large.length);
  expect(storage.continuityReceivedResults.size).toBe(0);
  session.acceptContinuityToolResults(f.request([largeOutput(calls[2]!.id)]));
  expect(storage.taskUpdateStorageBytes()).toBeLessThanOrEqual(TASK_UPDATE_SESSION_JOURNAL_BYTES);
  const running = f.run(f.request([output(calls[1]!.id, "changed retry"), output(calls[2]!.id, "changed retry")], "retry-rest"));
  let final = await f.wait(3);
  while (final.kind !== "result") final = await f.wait(3);
  await f.finish(); await running;
  expect(storage.continuityReceivedResults.size).toBe(0);
  expect(storage.continuityReceivedResultBytes).toBe(0);
}, 15_000);

test("A8 continuity compaction reuses the current logical source and local received results", async () => {
  const f = await fixture();
  const [call] = await batch(f);
  const appended = f.request([output(call!.id), user("append", "Preserve this current requirement.")]);
  const running = f.run(appended);
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  f.ack(reply.taskUpdate!);
  await f.finish(); await running;
  const session = f.session();
  const binding = session.runtime.continuityBinding!;
  const generation = session.continuityGenerationValue();
  const compact = f.request([user("append", "Preserve this current requirement.")]);
  compact._compactionRequest = true;
  const events = await f.run(compact);
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(binding.revision).toBe(1);
  expect(binding.logicalExecutionKey).toBeUndefined();
  expect(session.continuityGenerationValue()).toBe(generation);
  expect(f.pages.size).toBe(1);
  const replay = f.request([output(call!.id, "changed historical result body"), user("append", "Preserve this current requirement.")]);
  replay._compactionRequest = true;
  expect((await f.run(replay)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(binding.revision).toBe(1);
  expect(f.submissions()).toBe(2);
});

test("A8 stale compaction preflight cannot stop a new appended driver", async () => {
  const f = await fixture();
  const [call] = await batch(f);
  const compact = f.request([user("initial-user", "Inspect the project."), output(call!.id)]);
  compact._compactionRequest = true;
  await f.adapter.preflight!(compact, { headers: new Headers() });
  const disconnected = new AbortController();
  const incoming = f.request([output(call!.id), user("append", "A newer requirement.")]);
  const running = f.run(incoming, [], disconnected.signal);
  void running.catch(() => {});
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  f.ack(reply.taskUpdate!);
  disconnected.abort(); await running.catch(() => {});
  await expect(f.adapter.runTurn!(compact, { headers: new Headers() }, () => {})).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.session().driverGeneration()).toBe(1);
  expect(f.session().isActive()).toBeTrue();
  expect(f.session().isTaskUpdateCancelled()).toBeFalse();
  expect(f.session().runtime.continuityBinding!.revision).toBe(0);
});

test("A7 continuity blocks completion before ACK and rejects a late append after output lock", async () => {
  const f = await fixture(true);
  const [call] = await batch(f);
  const disconnected = new AbortController();
  const incoming = f.request([output(call!.id), user("append")]);
  const running = f.run(incoming, [], disconnected.signal);
  void running.catch(() => {});
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  expect(() => f.broker.completeSafeTurn(f.token(), "An answer that ignores the update", 1)).toThrow();
  expect(f.broker.taskUpdateState(f.token())?.finalOutputRevision).toBeNull();
  f.ack(reply.taskUpdate!);
  f.broker.beginFinalOutput(f.token(), { expectedDriverGeneration: 1, taskRevision: 1, acknowledgedRevision: 1 });
  await expect(f.run(f.request([user("too-late")]))).rejects.toMatchObject({ code: "task_update_final_output_started" });
  expect(f.session().taskRevision()).toBe(1);
  expect(f.session().isTaskUpdateCancelled()).toBeFalse();
  disconnected.abort(); await running.catch(() => {});
});

test("A3-A5 continuity accepts zero results and the next text-only append before ACK", async () => {
  const f = await fixture();
  const [call] = await batch(f);
  await f.run(f.request([user("append-one", "First update.")]));
  expect(f.broker.taskUpdateState(f.token())).toMatchObject({ acceptedRevision: 1, deliveredRevision: 0, acknowledgedRevision: 0 });
  await f.run(f.request([user("append-two", "Second update.")]));
  expect(f.session().taskRevision()).toBe(2);
  expect(f.session().driverGeneration()).toBe(2);
  expect(() => f.session().cancelDriver(0)).toThrow();
  const running = f.run(f.request([user("append-two", "Second update."), output(call!.id)]));
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  expect(reply.taskUpdate?.updates.map(update => update.content)).toEqual(["First update.", "Second update."]);
  f.ack(reply.taskUpdate!);
  await f.finish(); await running;
  expect(f.session().driverGeneration()).toBe(2);
  expect(f.submissions()).toBe(1);
});

test("A6 continuity rejects a conflicting earlier new ID in a multiple-instruction append while permitting changed old history", async () => {
  const f = await fixture();
  const [call] = await batch(f);
  await expect(f.run(f.request([user("new-A", "first text"), user("new-A", "conflicting text"),
    user("new-B", "last new instruction"), output(call!.id)])))
    .rejects.toMatchObject({ code: "task_update_message_conflict" });
  expect(f.session().taskRevision()).toBe(0);
  expect(f.session().driverGeneration()).toBe(0);
  expect(f.session().outstanding()).toHaveLength(1);
  expect(f.session().isTaskUpdateCancelled()).toBeFalse();
  const running = f.run(f.request([user("initial-user", "changed historical text"),
    user("initial-user", "another old-history serialization"), user("new-A", "first text"),
    user("new-B", "last new instruction"), output(call!.id)]));
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  expect(reply.taskUpdate?.updates.map(update => update.sourceMessageId)).toEqual(["new-A", "new-B"]);
  f.ack(reply.taskUpdate!);
  await f.finish(); await running;
  expect(f.session().taskRevision()).toBe(2);
  expect(f.session().driverGeneration()).toBe(1);
});

test("A6 continuity rejects a current result type and an accepted appended text conflict without completing the call", async () => {
  const f = await fixture();
  const [call] = await batch(f);
  await expect(f.run(f.request([{ type: "custom_tool_call_output", call_id: call!.id, output: "wrong" }, user("append")]))).rejects
    .toMatchObject({ code: "task_update_result_type_invalid" });
  expect(f.session().hasOutstanding(call!.id)).toBeTrue();
  expect(f.session().taskRevision()).toBe(0);
  await expect(f.run(f.request([user("duplicate-new", "First text."), user("duplicate-new", "Changed text.")]))).rejects
    .toMatchObject({ code: "task_update_message_conflict" });
  expect(f.session().taskRevision()).toBe(0);
  await f.run(f.request([user("append")]));
  await expect(f.run(f.request([user("append", "conflicting text")]))).rejects.toMatchObject({ code: "task_update_message_conflict" });
  expect(f.session().taskRevision()).toBe(1);
  expect(f.session().isTaskUpdateCancelled()).toBeFalse();
});

test("A7-A9 continuity reports no boundary and old protocol without cancelling their physical response", async () => {
  for (const protocol of [true, false]) {
    const f = await fixture(false, protocol);
    const disconnected = new AbortController();
    const running = f.run(f.initial, [], disconnected.signal);
    void running.catch(() => {});
    await f.ready;
    await expect(f.run(f.request([user("append")]))).rejects.toMatchObject({ code: protocol ? "task_update_no_boundary" : "task_update_upgrade_required" });
    expect(f.session().isActive()).toBeTrue();
    expect(f.session().isTaskUpdateCancelled()).toBeFalse();
    expect(f.submissions()).toBe(1);
    disconnected.abort();
    await running.catch(() => {});
    expect(f.session().isActive()).toBeTrue();
    const session = f.session();
    chatGptTurnSessions.cancelNativeTurn(session.nativeThreadId!, "turn", new DOMException("Explicit stop", "AbortError"));
    expect((await session.browserOutcome).type).toBe("error");
  }
});

for (const manual of [false, true]) test(`Review E1 ${manual ? "Zero Risk" : "Automatic"} rejects unacknowledged compaction before taking its source`, async () => {
  const f = await fixture(manual);
  const [call] = await batch(f);
  const disconnected = new AbortController();
  const running = f.run(f.request([output(call!.id), user("append")]), [], disconnected.signal);
  void running.catch(() => {});
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  const session = f.session();
  const binding = session.runtime.continuityBinding!;
  const lease = { ...binding.lease! };
  disconnected.abort(); await running.catch(() => {});
  const compact = f.request([user("append")]); compact._compactionRequest = true;
  await expect(f.run(compact)).rejects.toMatchObject({ code: "task_update_pending" });
  expect(session.isActive()).toBeTrue();
  expect(session.isTaskUpdateCancelled()).toBeFalse();
  expect(binding.state).toBe("running");
  expect(binding.lease).toEqual(lease);
  expect(binding.compactionKey).toBeUndefined();
  f.ack(reply.taskUpdate!);
  await f.finish();
});

test("Review E2 a stale compaction entering preflight after append cannot cancel the current driver", async () => {
  const f = await fixture();
  const [call] = await batch(f);
  await f.run(f.request([user("append")]));
  const session = f.session();
  const binding = session.runtime.continuityBinding!;
  const lease = { ...binding.lease! };
  const stale = f.request([user("initial-user", "Inspect the project."), output(call!.id)]);
  stale._compactionRequest = true;
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(session.driverGeneration()).toBe(1);
  expect(session.isActive()).toBeTrue();
  expect(session.isTaskUpdateCancelled()).toBeFalse();
  expect(binding.state).toBe("running");
  expect(binding.lease).toEqual(lease);
});

test("Review E3 discovery delivered with append remains available with its first accepted definition", async () => {
  const f = await fixture(false, true, true);
  const events: AdapterEvent[] = [];
  const original = f.run(f.initial, events);
  await f.ready;
  expect(await f.startTool(1, "tool_search")).toMatchObject({ kind: "pending" });
  await original;
  const call = events.find(event => event.type === "tool_call_start");
  if (call?.type !== "tool_call_start") throw new Error("Missing issued search call");
  const discovered = { type: "function", name: "discovered_tool", description: "First accepted definition.", parameters: { type: "object" } };
  const searchResult = { type: "tool_search_output", call_id: call.id, status: "completed", tools: [discovered] };
  const appended = f.request([searchResult, user("append")]);
  const running = f.run(appended);
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  f.ack(reply.taskUpdate!);
  expect(await f.startTool(2, "discovered_tool", 1)).toMatchObject({ kind: "pending" });
  const returned = await running;
  expect(returned.some(event => event.type === "tool_call_start" && event.name === "discovered_tool")).toBeTrue();
  const changed = f.request([{ ...searchResult, tools: [{ ...discovered, description: "Replacement must be ignored." }] },
    { ...searchResult, call_id: "unknown", tools: [{ ...discovered, name: "injected_tool" }] }, user("append")]);
  await f.run(changed);
  expect(f.session().runtime.continuityBinding!.discoveredTools).toMatchObject([{ name: "discovered_tool", description: "First accepted definition." }]);
  expect(changed.context.tools?.some(tool => tool.name === "injected_tool")).toBeFalse();
});

test("Review E4 a logical append succeeds at five physical sessions without allocating a sixth", async () => {
  const sessions = [];
  for (let index = 0; index < 5; index++) {
    const f = await fixture();
    await batch(f);
    sessions.push(f);
  }
  const first = sessions[0]!;
  const physical = first.session();
  await first.run(first.request([user("append")]));
  expect(first.session()).toBe(physical);
  expect(first.session().taskRevision()).toBe(1);
  expect(first.submissions()).toBe(1);
  expect(chatGptTurnSessions.activeCount()).toBe(5);
  const sixth = await fixture();
  await expect(sixth.run(sixth.initial)).rejects.toMatchObject({ code: "continuity_resource_capacity" });
  expect(sixth.submissions()).toBe(0);
});

test("Review R0 ordinary revision zero keeps current payload and complete result batch checks before compaction", async () => {
  const f = await fixture();
  const calls = await batch(f, 2);
  const changed = f.request([user("initial-user", "Changed current text."), ...calls.map(call => output(call.id))]);
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const partial = f.request([user("initial-user", "Inspect the project."), output(calls[0]!.id)]);
  await expect(f.run(partial)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.session().outstanding()).toHaveLength(2);
  expect(f.session().taskRevision()).toBe(0);
  const complete = f.request([user("initial-user", "Inspect the project."), ...calls.map(call => output(call.id))]);
  const running = f.run(complete);
  for (const id of [1, 2]) {
    let reply = await f.wait(id);
    while (reply.kind !== "result") reply = await f.wait(id);
  }
  await f.finish(); await running;
  expect(f.session().taskRevision()).toBe(0);
  const compact = f.request((complete._rawBody as { input: unknown[] }).input); compact._compactionRequest = true;
  expect((await f.run(compact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.session().runtime.continuityBinding!.revision).toBe(1);
});
