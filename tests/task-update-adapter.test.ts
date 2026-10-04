import { EventEmitter } from "node:events";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createConnection, type Socket } from "node:net";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { buildResponseJSON } from "../src/bridge";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { estimateChatGptWebUsage } from "../src/adapters/chatgpt-web/usage";
import { chatGptTurnExecutionKey, chatGptTurnRoundKey, chatGptTurnSessions,
  TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES, TASK_UPDATE_SESSION_JOURNAL_BYTES } from "../src/adapters/chatgpt-web/turn-execution";
import { taskUpdateSourceError } from "../src/adapters/chatgpt-web/task-update-source";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { callTurnBroker, RemoteTurnBroker, TurnBroker, type BrokerToolRequest } from "../src/adapters/chatgpt-web/turn-broker";
import type { NativeOperationReply } from "../src/adapters/chatgpt-web/native-tool-operations";
import type { TaskUpdateOwnerContext, UpdateDelivery } from "../src/adapters/chatgpt-web/task-update-protocol";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig, CodexTool } from "../src/types";

const testRoot = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-task-update-adapter-"));
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));
let sequence = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tools: CodexTool[] = [{
  name: "exec_command", description: "A harmless command in the outer Codex harness",
  parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
}];

function request(scope: string): CodexParsedRequest {
  const turnId = `turn-${scope}`;
  return {
    modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "high" },
    context: { tools, messages: [{ role: "user", content: "Inspect the project.", timestamp: 1 }] },
    _rawBody: {
      instructions: "Preserve higher-priority instructions.",
      prompt_cache_key: `thread-${scope}`,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `thread-${scope}`, turn_id: turnId }) },
      input: [{ type: "message", id: "initial-user", role: "user", content: [{ type: "input_text", text: "Inspect the project." }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["user.text"] } }],
    },
  };
}

function append(original: CodexParsedRequest, callId: string | undefined, updates: { id: string; text: string }[]): CodexParsedRequest {
  const next = structuredClone(original);
  const raw = next._rawBody as { input: Record<string, unknown>[] };
  const turnId = extractChatGptTurnIdentity(original).turnId;
  if (!turnId) throw new Error("The fixture lost its native turn identity");
  if (callId && !raw.input.some(item => item.type === "function_call_output" && item.call_id === callId)) {
    raw.input.push({ type: "function_call_output", call_id: callId, output: "  exact Native result\n" });
    next.context.messages.push({ role: "toolResult", toolCallId: callId, toolName: "exec_command", content: "  exact Native result\n", isError: false, timestamp: 2 });
  }
  for (const update of updates) {
    raw.input.push({ type: "message", id: update.id, role: "user", content: [{ type: "input_text", text: update.text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["user.text"] } });
    next.context.messages.push({ role: "user", content: update.text, timestamp: next.context.messages.length + 1 });
  }
  return next;
}

function addAcceptedHistory(parsed: CodexParsedRequest): void {
  (parsed._rawBody as { input: Record<string, unknown>[] }).input.unshift({ type: "function_call_output",
    call_id: "accepted-history", output: "Exact accepted prior result." });
  parsed.context.messages.unshift({ role: "toolResult", toolCallId: "accepted-history", toolName: "exec_command",
    content: "Exact accepted prior result.", isError: false, timestamp: 0 });
}

async function fixture(options: { remote?: boolean; structured?: boolean } = {}) {
  const scope = `update-${++sequence}`;
  const socket = defaultBrokerEndpoint(join(testRoot, scope));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://${scope}`,
    chatgptWeb: { brokerSocketPath: socket, localToolsEnabled: true, toolAuthorityMode: "delegated", solAvailable: true },
  };
  const broker = TurnBroker.forSocket(socket);
  if (options.remote) await broker.listen();
  const owner = options.remote ? new RemoteTurnBroker(socket) : broker;
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  const ready = deferred<{ token: string; turn: BrowserTurn }>();
  const answer = deferred<string>();
  const runs: { token: string; turn: BrowserTurn; answer: ReturnType<typeof deferred<string>> }[] = [];
  const runWaiters = new Map<number, ReturnType<typeof deferred<{ token: string; turn: BrowserTurn }>>>();
  const observed = new Map<number, ReturnType<typeof deferred<void>>>();
  const originalNext = broker.nextToolBatch.bind(broker);
  broker.nextToolBatch = (token, signal, context) => {
    const generation = context?.expectedDriverGeneration ?? -1;
    if (!observed.has(generation)) observed.set(generation, deferred<void>());
    observed.get(generation)!.resolve();
    return originalNext(token, signal, context);
  };
  let submissions = 0;
  worker.run = async turn => {
    submissions += 1;
    const compiled = await turn.prepare();
    const token = compiled.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
    if (!token) throw new Error("Missing Native capability in test prompt");
    expect(compiled.text).toContain("task-updates-v1");
    const runAnswer = submissions === 1 ? answer : deferred<string>();
    runs.push({ token, turn, answer: runAnswer });
    runWaiters.get(submissions - 1)?.resolve({ token, turn });
    void (async () => {
      let revision = 0;
      while (!turn.abortSignal?.aborted) {
        const snapshot = await turn.externalProgress!.waitForChange(revision, turn.abortSignal);
        revision = snapshot.revision;
        if (snapshot.lastToolBatchRevision > 0) await turn.externalProgress!.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
      }
    })().catch(() => {});
    ready.resolve({ token, turn });
    return new Promise<string>((resolveAnswer, rejectAnswer) => {
      const onAbort = () => rejectAnswer(turn.abortSignal?.reason ?? new DOMException("test cancelled", "AbortError"));
      turn.abortSignal?.addEventListener("abort", onAbort, { once: true });
      runAnswer.promise.then(resolveAnswer, rejectAnswer).finally(() => turn.abortSignal?.removeEventListener("abort", onAbort));
    });
  };
  const adapter = createChatGptWebAdapter(provider, { broker: owner });
  const initial = request(scope);
  if (options.structured) initial.options.outputFormat = { type: "json_schema", name: "answer", strict: true,
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } };
  const run = async (parsed: CodexParsedRequest, events: AdapterEvent[] = [], signal?: AbortSignal,
    observe?: (event: AdapterEvent) => void, onProgress?: () => void) => {
    await adapter.runTurn!(parsed, { headers: new Headers(), ...(signal ? { abortSignal: signal } : {}), onProgress }, event => {
      events.push(event);
      observe?.(event);
    });
    return events;
  };
  const start = (token: string, id: number, revision: number) => callTurnBroker<NativeOperationReply & { taskUpdate?: UpdateDelivery }>(socket, {
    method: "native_operation_start", token, contract: "native", nativeWaitProtocol: 1, taskUpdateProtocol: 1,
    operationId: id, taskRevision: revision, entry: "codex_exec", nativeInput: { cmd: "inert fixture" }, waitMs: 1,
  }, 5_000);
  const wait = (token: string, id: number) => callTurnBroker<NativeOperationReply & { taskUpdate?: UpdateDelivery }>(socket, {
    method: "native_operation_wait", token, contract: "native", nativeWaitProtocol: 1, operationId: id, waitMs: 30_000,
  }, 5_000);
  return {
    broker, owner, socket, ready: ready.promise, answer, run, start, wait, initial, submissions: () => submissions,
    session: () => chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(initial)}`)!,
    observing: (generation: number) => {
      if (!observed.has(generation)) observed.set(generation, deferred<void>());
      return observed.get(generation)!.promise;
    },
    nextRun: (index: number) => {
      if (runs[index]) return Promise.resolve(runs[index]!);
      if (!runWaiters.has(index)) runWaiters.set(index, deferred<{ token: string; turn: BrowserTurn }>());
      return runWaiters.get(index)!.promise;
    },
    finish: async (token: string, turn: BrowserTurn, value: string, context: TaskUpdateOwnerContext) => {
      // The real browser captures this ACK head together with the first visible projection.
      turn.onTextDelta(value, { ...context, acknowledgedRevision: context.acknowledgedRevision
        ?? broker.taskUpdateState(token)?.acknowledgedRevision });
      runs.find(run => run.token === token)!.answer.resolve(value);
    },
    close: async () => {
      worker.run = originalRun;
      chatGptTurnSessions.clear();
      for (const run of runs) run.answer.resolve("");
      await Promise.allSettled(runs.map(run => owner.waitForRetirement(run.token)));
      await broker.close();
    },
  };
}

async function originalBatch(f: Awaited<ReturnType<typeof fixture>>) {
  const events: AdapterEvent[] = [];
  const round = f.run(f.initial, events);
  const ready = await f.ready;
  expect(await f.start(ready.token, 1, 0)).toMatchObject({ kind: "pending" });
  await round;
  const call = events.find(event => event.type === "tool_call_start");
  if (call?.type !== "tool_call_start") throw new Error("Missing initial call");
  return { ...ready, callId: call.id, events };
}

async function ack(f: Awaited<ReturnType<typeof fixture>>, token: string, delivery: UpdateDelivery) {
  return callTurnBroker<{ taskUpdate?: UpdateDelivery; acknowledgedRevision: number }>(f.socket, {
    method: "task_update_ack", token, contract: "native", taskUpdateProtocol: 1,
    deliveryId: delivery.deliveryId, throughRevision: delivery.throughRevision,
  }, 5_000);
}

describe("Automatic Adapter task updates", () => {
  test("initial source capacity rejection happens before creating a browser runtime", async () => {
    const f = await fixture();
    try {
      (f.initial._rawBody as { input: Record<string, unknown>[] }).input.unshift({ type: "message", role: "developer",
        content: [{ type: "input_text", text: "x".repeat(TASK_UPDATE_SESSION_JOURNAL_BYTES) }] });
      await expect(f.run(f.initial)).rejects.toMatchObject({ code: "task_update_capacity" });
      expect(f.submissions()).toBe(0);
      expect(f.session()).toBeUndefined();
    } finally { await f.close(); }
  });

  for (const historical of [false, true]) test(`no current tool boundary preserves ${historical ? "exact accepted historical results" : "plain-text"} replacement behavior`, async () => {
    const f = await fixture();
    try {
      if (historical) addAcceptedHistory(f.initial);
      const original = f.run(f.initial).catch(error => error);
      await f.ready;
      await f.observing(0);
      const next = append(f.initial, undefined, [{ id: "update-without-tools", text: "Include validation." }]);
      const events: AdapterEvent[] = [];
      const round = f.run(next, events).catch(error => error);
      const replacement = await f.nextRun(1);
      await original;
      await f.finish(replacement.token, replacement.turn, "Full replacement answer.", { expectedDriverGeneration: 0, taskRevision: 0 });
      expect(await round).toEqual(events);
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect(f.submissions()).toBe(2);
    } finally { await f.close(); }
  });

  for (const changedHistory of [false, true]) test(`without a Session batch ${changedHistory ? "changed historical" : "unknown"} raw results reject without replacing the owner`, async () => {
    const f = await fixture();
    try {
      if (changedHistory) addAcceptedHistory(f.initial);
      const original = f.run(f.initial).catch(error => error);
      const { token, turn } = await f.ready;
      await f.observing(0);
      const session = f.session();
      const next = append(f.initial, changedHistory ? "accepted-history" : "never-issued", [{ id: "update-1", text: "Include validation." }]);
      if (changedHistory) {
        (next._rawBody as { input: Record<string, unknown>[] }).input.find(item => item.call_id === "accepted-history")!.output = "Changed prior result.";
      }
      await expect(f.run(next)).rejects.toMatchObject({ code: "task_update_source_unproven" });
      expect(f.session()).toBe(session);
      expect(session.isTaskUpdateCancelled()).toBe(false);
      expect(session.taskRevision()).toBe(0);
      expect(session.driverGeneration()).toBe(0);
      expect(await f.owner.taskUpdateState(token)).toMatchObject({ acceptedRevision: 0, driverGeneration: 0, finalOutputRevision: null });
      expect(f.submissions()).toBe(1);
      await f.finish(token, turn, "Original task answer.", { expectedDriverGeneration: 0, taskRevision: 0 });
      expect(await original).toBeArray();
    } finally { await f.close(); }
  });

  test("Remote handoff before Session registration rejects unproven results and later admits the same complete source request", async () => {
    const f = await fixture({ remote: true });
    const handed = deferred<BrokerToolRequest[]>();
    const release = deferred<void>();
    const nextBatch = f.broker.nextToolBatch.bind(f.broker);
    let hold = true;
    f.broker.nextToolBatch = async (token, signal, context) => {
      const requests = await nextBatch(token, signal, context);
      if (hold && context?.expectedDriverGeneration === 0 && requests.length) {
        hold = false;
        handed.resolve(requests);
        await release.promise;
      }
      return requests;
    };
    try {
      const sourceEvents: AdapterEvent[] = [];
      const original = f.run(f.initial, sourceEvents).catch(error => error);
      const { token, turn } = await f.ready;
      expect(await f.start(token, 1, 0)).toMatchObject({ kind: "pending" });
      const requests = await handed.promise;
      const session = f.session();
      expect(sourceEvents.some(event => event.type === "tool_call_start" || event.type === "done")).toBe(false);
      const next = append(f.initial, requests[0]!.callId, [{ id: "update-1", text: "Include validation." }]);
      await expect(f.run(next)).rejects.toMatchObject({ code: "task_update_source_unproven" });
      expect(f.session()).toBe(session);
      expect(session.isTaskUpdateCancelled()).toBe(false);
      expect(await f.owner.taskUpdateState(token)).toMatchObject({ acceptedRevision: 0, driverGeneration: 0 });
      expect(f.submissions()).toBe(1);
      release.resolve();
      expect(await original).toEqual(sourceEvents);
      expect(sourceEvents.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
      const events: AdapterEvent[] = [];
      const round = f.run(next, events).catch(error => error);
      const result = await f.wait(token, 1);
      expect(result).toMatchObject({ kind: "result", taskUpdate: { throughRevision: 1 } });
      await ack(f, token, result.taskUpdate!);
      await f.finish(token, turn, "Complete answer with validation.", { expectedDriverGeneration: 1, taskRevision: 1 });
      expect(await round).toEqual(events);
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect(f.submissions()).toBe(1);
    } finally { release.resolve(); await f.close(); }
  });

  test("disconnect at the tool terminal retains complete source proof for replay and an in-flight update", async () => {
    const f = await fixture();
    try {
      const abort = new AbortController();
      const sourceEvents: AdapterEvent[] = [];
      const sourceRound = f.run(f.initial, sourceEvents, abort.signal, event => {
        if (event.type === "done" && event.stopReason === "tool_use") {
          abort.abort();
          throw new DOMException("HTTP observer disconnected at tool terminal", "AbortError");
        }
      }).catch(error => error);
      const { token, turn } = await f.ready;
      expect(await f.start(token, 1, 0)).toMatchObject({ kind: "pending" });
      expect(await sourceRound).toBeInstanceOf(DOMException);
      const call = sourceEvents.find(event => event.type === "tool_call_start");
      if (call?.type !== "tool_call_start") throw new Error("Missing source tool call");
      const replay = await f.run(f.initial);
      expect(replay.filter(event => event.type !== "heartbeat")).toEqual(sourceEvents.filter(event => event.type !== "heartbeat"));
      const next = append(f.initial, call.id, [{ id: "update-after-reconnect", text: "Include the test results." }]);
      const events: AdapterEvent[] = [];
      const round = f.run(next, events).catch(error => error);
      const result = await f.wait(token, 1);
      expect(result).toMatchObject({ kind: "result", taskUpdate: { throughRevision: 1,
        updates: [{ sourceMessageId: "update-after-reconnect", content: "Include the test results." }] } });
      await ack(f, token, result.taskUpdate!);
      await f.finish(token, turn, "Complete answer with the test results.", { expectedDriverGeneration: 1, taskRevision: 1 });
      expect(await round).toEqual(events);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      expect(f.submissions()).toBe(1);
    } finally { await f.close(); }
  });

  test("complete old result plus a trusted append reuses one physical response and preserves round replay", async () => {
    const f = await fixture();
    try {
      const oldEvents: AdapterEvent[] = [];
      const oldRound = f.run(f.initial, oldEvents);
      const { token, turn } = await f.ready;
      expect(await f.start(token, 1, 0)).toMatchObject({ kind: "pending" });
      await oldRound;
      const call = oldEvents.find(event => event.type === "tool_call_start");
      if (call?.type !== "tool_call_start") throw new Error("No original Native call");
      expect(oldEvents.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
      const next = append(f.initial, call.id, [{ id: "update-1", text: "Include the test results." }]);
      const nextEvents: AdapterEvent[] = [];
      const nextRound = f.run(next, nextEvents);
      const result = await f.wait(token, 1);
      expect(result).toMatchObject({ kind: "result", result: { content: [{ type: "text", text: "  exact Native result\n" }] },
        taskUpdate: { throughRevision: 1, updates: [{ content: "Include the test results." }] } });
      expect(f.submissions()).toBe(1);
      await callTurnBroker(f.socket, { method: "task_update_ack", token, contract: "native", taskUpdateProtocol: 1, deliveryId: result.taskUpdate!.deliveryId, throughRevision: 1 }, 5_000);
      await f.finish(token, turn, "Complete answer including the test results.", { expectedDriverGeneration: 1, taskRevision: 1 });
      await nextRound;
      expect(nextEvents.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe("Complete answer including the test results.");
      expect(nextEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      const replay = await f.run(f.initial);
      expect(replay.filter(event => event.type !== "heartbeat")).toEqual(oldEvents.filter(event => event.type !== "heartbeat"));
      expect(f.submissions()).toBe(1);
    } finally { await f.close(); }
  });

  test("continuous append ends only the old observer and ACK replies deliver revisions in order", async () => {
    const f = await fixture();
    try {
      const { token, turn, callId } = await originalBatch(f);
      const one = append(f.initial, callId, [{ id: "update-1", text: "Use concise prose." }]);
      const oldEvents: AdapterEvent[] = [];
      const oldAbort = new AbortController();
      const oldObserver = f.run(one, oldEvents, oldAbort.signal);
      const first = await f.wait(token, 1);
      await f.observing(1);
      const two = append(one, callId, [{ id: "update-2", text: "Use concise prose." }]);
      const newestEvents: AdapterEvent[] = [];
      const newest = f.run(two, newestEvents);
      await oldObserver;
      expect(oldEvents.at(-1)).toEqual({ type: "incomplete", reason: "task_update_handoff", retryable: false, endTurn: false });
      expect(buildResponseJSON(oldEvents, CHATGPT_WEB_MODEL_ID)).toMatchObject({ status: "incomplete",
        incomplete_details: { reason: "task_update_handoff", retryable: false }, end_turn: false });
      oldAbort.abort();
      const nextDelivery = await ack(f, token, first.taskUpdate!);
      expect(nextDelivery).toMatchObject({ acknowledgedRevision: 1, taskUpdate: { throughRevision: 2,
        updates: [{ revision: 2, sourceMessageId: "update-2", content: "Use concise prose." }] } });
      await ack(f, token, nextDelivery.taskUpdate!);
      await f.finish(token, turn, "Concise complete answer.", { expectedDriverGeneration: 2, taskRevision: 2 });
      await newest;
      expect(newestEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
      const replay = await f.run(one);
      expect(replay.at(-1)).toEqual(oldEvents.at(-1)!);
      expect(f.submissions()).toBe(1);
    } finally { await f.close(); }
  });

  test("a committed Remote transfer with a lost receipt is recovered without duplicate result or browser work", async () => {
    const f = await fixture({ remote: true });
    try {
      const { token, turn, callId } = await originalBatch(f);
      const remote = f.owner as RemoteTurnBroker;
      const accept = remote.acceptTaskUpdate.bind(remote);
      let accepts = 0;
      remote.acceptTaskUpdate = async (...args) => {
        const outcome = await accept(...args);
        if (++accepts === 1) throw new Error("simulated receipt loss after commit");
        return outcome;
      };
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const events: AdapterEvent[] = [];
      const round = f.run(next, events);
      const result = await f.wait(token, 1);
      await ack(f, token, result.taskUpdate!);
      await f.finish(token, turn, "Full answer with validation.", { expectedDriverGeneration: 1, taskRevision: 1 });
      await round;
      expect(f.broker.taskUpdateState(token)).toMatchObject({ acceptedRevision: 1, driverGeneration: 1 });
      expect(accepts).toBe(1);
      expect(f.submissions()).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    } finally { await f.close(); }
  });

  test("an invalid result batch cannot rebuild the browser or partially accept the update", async () => {
    const f = await fixture();
    try {
      const { token, turn, callId } = await originalBatch(f);
      const invalid = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const raw = invalid._rawBody as { input: Record<string, unknown>[] };
      raw.input.splice(2, 0, { type: "function_call_output", call_id: callId, output: "changed duplicate" });
      await expect(f.run(invalid)).rejects.toMatchObject({ code: "task_update_source_unproven" });
      expect(f.broker.taskUpdateState(token)).toMatchObject({ acceptedRevision: 0, driverGeneration: 0 });
      expect(f.submissions()).toBe(1);
      const valid = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const events: AdapterEvent[] = [];
      const round = f.run(valid, events);
      const result = await f.wait(token, 1);
      await ack(f, token, result.taskUpdate!);
      await f.finish(token, turn, "Validated answer.", { expectedDriverGeneration: 1, taskRevision: 1 });
      await round;
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    } finally { await f.close(); }
  });

  test("unknown commit receipts keep the transfer isolated until an identical reconnect recovers it", async () => {
    const f = await fixture({ remote: true });
    try {
      const { token, turn, callId } = await originalBatch(f);
      const remote = f.owner as RemoteTurnBroker;
      const accept = remote.acceptTaskUpdate.bind(remote);
      const outcome = remote.taskUpdateTransferOutcome.bind(remote);
      const transferIds: string[] = [];
      let lost = true;
      remote.acceptTaskUpdate = async (...args) => {
        transferIds.push(args[1].transferId);
        const receipt = await accept(...args);
        if (lost) throw new Error("receipt unavailable after commit");
        return receipt;
      };
      remote.taskUpdateTransferOutcome = async (...args) => {
        if (lost) throw new Error("outcome transport unavailable");
        return outcome(...args);
      };
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      await expect(f.run(next)).rejects.toMatchObject({ code: "task_update_transfer_unknown" });
      expect(f.session().hasPendingTaskUpdate()).toBe(true);
      expect(f.session().driverGeneration()).toBe(0);
      expect(f.broker.taskUpdateState(token)).toMatchObject({ acceptedRevision: 1, driverGeneration: 1 });
      lost = false;
      const events: AdapterEvent[] = [];
      const reconnect = f.run(next, events);
      const result = await f.wait(token, 1);
      await ack(f, token, result.taskUpdate!);
      await f.finish(token, turn, "Recovered complete answer.", { expectedDriverGeneration: 1, taskRevision: 1 });
      await reconnect;
      expect(new Set(transferIds).size).toBe(1);
      expect(f.session().hasPendingTaskUpdate()).toBe(false);
      expect(f.submissions()).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    } finally { await f.close(); }
  });

  test("a lost preparation rejection never permits an unprepared accept on reconnect", async () => {
    const f = await fixture();
    try {
      const { token, turn, callId } = await originalBatch(f);
      const session = f.session();
      const prepare = session.prepareTaskUpdate.bind(session);
      session.prepareTaskUpdate = () => { throw taskUpdateSourceError("task_update_capacity", "Controlled preparation capacity rejection."); };
      const reject = f.broker.rejectTaskUpdateReservation.bind(f.broker);
      let rejected = false;
      f.broker.rejectTaskUpdateReservation = (...args) => {
        const receipt = reject(...args);
        if (!rejected) { rejected = true; throw new Error("lost rejection receipt"); }
        return receipt;
      };
      const accept = f.broker.acceptTaskUpdate.bind(f.broker);
      let accepts = 0;
      f.broker.acceptTaskUpdate = (...args) => { accepts += 1; return accept(...args); };
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      await expect(f.run(next)).rejects.toMatchObject({ code: "task_update_transfer_unknown" });
      await expect(f.run(next)).rejects.toMatchObject({ code: "task_update_capacity" });
      expect(accepts).toBe(0);
      expect(f.broker.taskUpdateState(token)).toMatchObject({ acceptedRevision: 0, driverGeneration: 0 });
      expect(session.hasPendingTaskUpdate()).toBe(false);
      session.prepareTaskUpdate = prepare;
      const resultOnly = append(f.initial, callId, []);
      const events: AdapterEvent[] = [];
      const round = f.run(resultOnly, events);
      expect(await f.wait(token, 1)).toMatchObject({ kind: "result" });
      await f.finish(token, turn, "Original task completed.", { expectedDriverGeneration: 0, taskRevision: 0 });
      await round;
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect(f.submissions()).toBe(1);
    } finally { await f.close(); }
  });

  test("trusted stop retires an unknown transfer without requiring its disconnected request to reconnect", async () => {
    const f = await fixture({ remote: true });
    try {
      const { token, callId } = await originalBatch(f);
      const remote = f.owner as RemoteTurnBroker;
      const accept = remote.acceptTaskUpdate.bind(remote);
      remote.acceptTaskUpdate = async (...args) => { await accept(...args); throw new Error("lost commit receipt"); };
      remote.taskUpdateTransferOutcome = async () => { throw new Error("outcome unavailable"); };
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      await expect(f.run(next)).rejects.toMatchObject({ code: "task_update_transfer_unknown" });
      const session = f.session();
      const identity = extractChatGptTurnIdentity(f.initial);
      expect(session.hasPendingTaskUpdate()).toBe(true);
      const stopped = chatGptTurnSessions.cancelNativeTurn(identity.threadId!, identity.turnId!, new Error("trusted user stop"));
      expect(stopped.cancelled).toBe(1);
      await stopped.settlement;
      expect(session.isActive()).toBe(false);
      expect(() => session.assertDriverGeneration(0)).toThrow("no longer owns");
      await remote.waitForRetirement(token);
      expect(f.submissions()).toBe(1);
      expect(chatGptTurnSessions.activeCount()).toBe(0);
    } finally { await f.close(); }
  });

  test("real error, image, resource and metadata results survive Adapter transfer unchanged", async () => {
    const f = await fixture();
    try {
      const { token, turn, callId } = await originalBatch(f);
      const next = append(f.initial, callId, [{ id: "update-1", text: "Explain the actual failure." }]);
      const result = { content: [{ type: "text", text: "  original failure\n" },
        { type: "image", data: "cGljdHVyZQ==", mimeType: "image/png" },
        { type: "resource", resource: { uri: "fixture://result", mimeType: "text/plain", text: "exact resource" } }],
        structuredContent: { task_update: "untrusted Native field", detail: 7 }, isError: true,
        _meta: { provider: "original", task_update: { acceptedRevision: 999 } } };
      (next._rawBody as { input: Record<string, unknown>[] }).input.find(item => item.call_id === callId)!.output = result;
      const round = f.run(next);
      const reply = await f.wait(token, 1);
      expect(reply).toMatchObject({ kind: "result", taskUpdate: { throughRevision: 1 } });
      if (reply.kind !== "result") throw new Error("Missing public Native result");
      expect(reply.result).toEqual(result);
      await ack(f, token, reply.taskUpdate!);
      await f.finish(token, turn, "Complete explanation of the failure.", { expectedDriverGeneration: 1, taskRevision: 1 });
      await round;
      expect(f.submissions()).toBe(1);
    } finally { await f.close(); }
  });

  test("after the ACK gap closes a result replay with a new instruction follows the existing replacement path", async () => {
    const f = await fixture();
    try {
      const { token, callId } = await originalBatch(f);
      const one = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const prior = f.run(one);
      const result = await f.wait(token, 1);
      await ack(f, token, result.taskUpdate!);
      await f.observing(1);
      const two = append(one, callId, [{ id: "update-2", text: "Add a conclusion." }]);
      const events: AdapterEvent[] = [];
      const newest = f.run(two, events);
      const replacement = await f.nextRun(1);
      expect(replacement.token).not.toBe(token);
      await prior;
      await f.finish(replacement.token, replacement.turn, "Full replacement answer.", { expectedDriverGeneration: 0, taskRevision: 0 });
      await newest;
      expect(f.submissions()).toBe(2);
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    } finally { await f.close(); }
  });

  test("unacknowledged final text fails without emitting a successful answer", async () => {
    const f = await fixture();
    try {
      const { token, turn, callId } = await originalBatch(f);
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const events: AdapterEvent[] = [];
      const round = f.run(next, events);
      expect((await f.wait(token, 1)).taskUpdate).toBeDefined();
      await f.finish(token, turn, "Old answer.", { expectedDriverGeneration: 1, taskRevision: 1 });
      await round;
      expect(events.at(-1)).toMatchObject({ type: "error", code: "task_update_unacknowledged", retryable: false });
      expect(events.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
      expect(events.some(event => event.type === "done" && event.endTurn)).toBe(false);
    } finally { await f.close(); }
  });

  test("failed error registration still closes only the current owner", async () => {
    const f = await fixture();
    try {
      const { token, turn, callId } = await originalBatch(f);
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const round = f.run(next).catch(error => error);
      expect((await f.wait(token, 1)).taskUpdate).toBeDefined();
      await f.observing(1);
      const session = f.session();
      const failure = new Error("isolated terminal-registration failure");
      session.appendRoundError = () => { throw failure; };
      turn.onTextDelta("Unacknowledged answer.", { expectedDriverGeneration: 1, taskRevision: 1 });
      expect(await round).toBe(failure);
      expect(session.isTaskUpdateCancelled()).toBe(true);
      await session.browserOutcome;
      await session.physicalSettlement;
      await f.owner.waitForRetirement(token);
      expect(session.isActive()).toBe(false);
      expect(f.submissions()).toBe(1);
    } finally { await f.close(); }
  });

  test("journal exhaustion preserves a replayable capacity error and retires physical authority", async () => {
    const f = await fixture();
    try {
      const { token, turn, callId } = await originalBatch(f);
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const events: AdapterEvent[] = [];
      const round = f.run(next, events).catch(error => error);
      const result = await f.wait(token, 1);
      await ack(f, token, result.taskUpdate!);
      await f.observing(1);
      const session = f.session();
      const roundKey = chatGptTurnRoundKey(next);
      expect(session.hasPendingTaskUpdate()).toBe(false);
      const budget = session as unknown as { taskUpdateSourceBytes: number; taskUpdateJournalBytes: number;
        taskUpdateErrorRoundReserves: Set<string> };
      const remaining = TASK_UPDATE_SESSION_JOURNAL_BYTES - budget.taskUpdateSourceBytes - budget.taskUpdateJournalBytes
        - budget.taskUpdateErrorRoundReserves.size * TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES;
      const padding: AdapterEvent = { type: "text_delta", text: "", phase: "commentary" };
      const overhead = Buffer.byteLength(JSON.stringify([padding]));
      padding.text = "x".repeat(remaining - overhead - 1);
      session.appendRoundEvents(roundKey, [padding]);
      turn.onTextDelta("Complete answer.", { expectedDriverGeneration: 1, taskRevision: 1 });
      expect(await round).toEqual(events);
      const terminal = events.at(-1);
      expect(terminal).toMatchObject({ type: "error", code: "task_update_capacity", retryable: false });
      expect(events.some(event => event.type === "done" && event.endTurn)).toBe(false);
      expect(session.roundCompleted(roundKey)).toBe(true);
      expect(session.isTaskUpdateCancelled()).toBe(true);
      expect(budget.taskUpdateSourceBytes + budget.taskUpdateJournalBytes).toBeLessThanOrEqual(TASK_UPDATE_SESSION_JOURNAL_BYTES);
      await session.browserOutcome;
      await session.physicalSettlement;
      await f.owner.waitForRetirement(token);
      expect(session.isActive()).toBe(false);
      const replay = await f.run(next);
      expect(replay.at(-1)).toEqual(terminal!);
      expect(f.submissions()).toBe(1);
    } finally { await f.close(); }
  });

  for (const remote of [false, true]) for (const concurrent of [false, true]) {
    test(`${remote ? "Remote" : "Local"} candidate inheritance capacity failure retires authority${concurrent ? " with a concurrent exact retry" : ""}`, async () => {
      const f = await fixture({ remote, structured: true });
      try {
        let requests: BrokerToolRequest[] = [];
        const originalNext = f.owner.nextToolBatch.bind(f.owner);
        f.owner.nextToolBatch = async (...args) => {
          const batch = await originalNext(...args);
          requests = batch;
          return batch;
        };
        const sourceEvents: AdapterEvent[] = [];
        const consumed = deferred<void>();
        let textObserved = false;
        const sourceRun = f.run(f.initial, sourceEvents, undefined, undefined, () => {
          if (textObserved) consumed.resolve();
        });
        const { token, turn } = await f.ready;
        await f.observing(0);
        const candidate = { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 };
        textObserved = true;
        turn.onTextDelta('{"answer":"Before tool', candidate);
        await consumed.promise;
        const session = f.session();
        const budget = session as unknown as { taskUpdateSourceBytes: number; taskUpdateJournalBytes: number;
          taskUpdateErrorRoundReserves: Set<string> };
        const available = () => TASK_UPDATE_SESSION_JOURNAL_BYTES - budget.taskUpdateSourceBytes
          - budget.taskUpdateJournalBytes - budget.taskUpdateErrorRoundReserves.size * TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES;
        const progress = turn.externalProgress!;
        const originalAck = progress.acknowledgeToolBatch.bind(progress);
        let filled = false;
        progress.acknowledgeToolBatch = async revision => {
          if (!filled) {
            filled = true;
            expect(requests.length).toBe(1);
            const room = available();
            const traceOverhead = Buffer.byteLength(JSON.stringify([""]))
              + Buffer.byteLength(JSON.stringify([{ type: "text_delta", text: "", phase: "commentary" }]));
            // Fill through normal browser commentary, leaving space for error reservation
            // but fewer bytes than the original candidate. Spaces keep tokenization bounded.
            const padding = (length: number) => " x".repeat(Math.floor(length / 2)) + (length % 2 ? "x" : "");
            let length = Math.floor((room - traceOverhead - 600 - 24) / 2);
            for (let attempt = 0; attempt < 3; attempt++) {
              const usage = estimateChatGptWebUsage(f.initial, { reasoning: [padding(length)], toolRequests: requests },
                turn.capabilities, false, false);
              const events: AdapterEvent[] = requests.flatMap(request => [
                { type: "tool_call_start", id: request.callId, name: request.wireName },
                { type: "tool_call_delta", arguments: JSON.stringify(request.arguments ?? {}) },
                { type: "tool_call_end" },
              ]);
              events.push({ type: "done", stopReason: "tool_use", endTurn: false, usage });
              length = Math.floor((room - traceOverhead - Buffer.byteLength(JSON.stringify(events)) - 24) / 2);
            }
            turn.onCommentary!(padding(length), true);
          }
          await originalAck(revision);
        };
        expect(await f.start(token, 1, 0)).toMatchObject({ kind: "pending" });
        await sourceRun;
        expect(filled).toBe(true);
        expect(sourceEvents.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
        expect(available()).toBeGreaterThanOrEqual(TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES);
        expect(available()).toBeLessThan(TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES + Buffer.byteLength(JSON.stringify(candidate)));
        const call = sourceEvents.find(event => event.type === "tool_call_start");
        if (call?.type !== "tool_call_start") throw new Error("Missing source tool batch");
        const next = append(f.initial, call.id, []);
        let deliveries = 0;
        const originalComplete = f.owner.completeTool.bind(f.owner);
        f.owner.completeTool = async (...args) => { deliveries++; return originalComplete(...args); };
        const resultRun = f.run(next);
        const retry = concurrent ? f.run(next) : undefined;
        const events = await resultRun;
        expect(events.at(-1)).toMatchObject({ type: "error", code: "task_update_capacity", retryable: false });
        if (retry) expect(await retry).toEqual(events);
        expect(await f.run(next)).toEqual(events);
        expect(deliveries).toBe(0);
        expect(session.isTaskUpdateCancelled()).toBe(true);
        expect(available()).toBeGreaterThanOrEqual(0);
        await session.browserOutcome;
        await session.physicalSettlement;
        await f.owner.waitForRetirement(token);
        expect(session.isActive()).toBe(false);
        await expect(f.start(token, 2, 0)).rejects.toBeDefined();
        expect(f.submissions()).toBe(1);
      } finally { await f.close(); }
    }, 60_000);
  }

  for (const remote of [false, true]) test(`${remote ? "Remote" : "Local"} strict output rejects pre-ACK text even when ACK arrives before completion`, async () => {
    const f = await fixture({ structured: true, remote });
    try {
      const { token, turn, callId } = await originalBatch(f);
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const events: AdapterEvent[] = [];
      const consumed = deferred<void>();
      let textObserved = false;
      const round = f.run(next, events, undefined, undefined, () => {
        if (textObserved) consumed.resolve();
      });
      const result = await f.wait(token, 1);
      await f.observing(1);
      const candidate = { expectedDriverGeneration: 1, taskRevision: 1 };
      const answer = '{"answer":"Unacknowledged answer."}';
      expect(f.broker.taskUpdateState(token)).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 0 });
      textObserved = true;
      turn.onTextDelta(answer, candidate);
      // Wait for consumption or immediate rejection, without settling the browser or a timer.
      await Promise.race([consumed.promise, round]);
      try { await ack(f, token, result.taskUpdate!); } catch (error) {
        expect(error).toMatchObject({ code: "codex_tool_operation_retired" });
      }
      try {
        const ticket = await turn.completionFence!.begin(candidate);
        if (ticket !== undefined) await turn.completionFence!.commit(ticket, candidate);
      } catch (error) {
        expect(error).toMatchObject({ code: "task_update_unacknowledged" });
      }
      f.answer.resolve(answer);
      await round;
      expect(events.at(-1)).toMatchObject({ type: "error", code: "task_update_unacknowledged", retryable: false });
      expect(events.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
      expect(events.some(event => event.type === "done" && event.endTurn)).toBe(false);
      expect((await f.run(next)).at(-1)).toEqual(events.at(-1)!);
      expect(f.submissions()).toBe(1);
    } finally { await f.close(); }
  });

  for (const remote of [false, true]) test(`${remote ? "Remote" : "Local"} strict output uses the completion receipt before validating and sending buffered text`, async () => {
    const f = await fixture({ structured: true, remote });
    try {
      const { token, turn, callId } = await originalBatch(f);
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const events: AdapterEvent[] = [];
      const round = f.run(next, events);
      const result = await f.wait(token, 1);
      await ack(f, token, result.taskUpdate!);
      const candidate = { expectedDriverGeneration: 1, taskRevision: 1 };
      const ticket = await turn.completionFence!.begin(candidate);
      expect(ticket).toBeNumber();
      expect(await turn.completionFence!.commit(ticket!, candidate)).toBe(true);
      expect(events.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
      await f.finish(token, turn, '{"answer":"Validated answer."}', candidate);
      await round;
      expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")).toEqual([
        { type: "text_delta", text: '{"answer":"Validated answer."}', phase: "final_answer" },
      ]);
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    } finally { await f.close(); }
  });

  for (const remote of [false, true]) for (const disconnected of [false, true]) {
    test(`${remote ? "Remote" : "Local"} buffered strict text survives an ordinary result round${disconnected ? " and retired reconnect" : ""}`, async () => {
      const f = await fixture({ remote, structured: true });
      try {
        const sourceEvents: AdapterEvent[] = [];
        const consumed = deferred<void>();
        let textObserved = false;
        const sourceRun = f.run(f.initial, sourceEvents, undefined, undefined, () => {
          if (textObserved) consumed.resolve();
        });
        const { token, turn } = await f.ready;
        await f.observing(0);
        const candidate = { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 };
        const answer = '{"answer":"Before tool and after tool."}';
        textObserved = true;
        turn.onTextDelta(disconnected ? answer : '{"answer":"Before tool', candidate);
        await consumed.promise;
        expect((await f.owner.taskUpdateState!(token))!.finalOutputRevision).toBeNull();
        expect(await f.start(token, 1, 0)).toMatchObject({ kind: "pending" });
        await sourceRun;
        const call = sourceEvents.find(event => event.type === "tool_call_start");
        if (call?.type !== "tool_call_start") throw new Error("Missing source tool batch");
        expect(sourceEvents.at(-1)).toMatchObject({ type: "done", endTurn: false, stopReason: "tool_use" });
        const next = append(f.initial, call.id, []);
        const nextEvents: AdapterEvent[] = [];
        const observingResult = deferred<void>();
        const originalNext = f.owner.nextToolBatch.bind(f.owner);
        f.owner.nextToolBatch = (capability, signal, context) => {
          observingResult.resolve();
          return originalNext(capability, signal, context);
        };
        const abort = new AbortController();
        const resultRun = f.run(next, nextEvents, abort.signal).catch(error => error);
        await Promise.race([observingResult.promise, resultRun]);
        expect(nextEvents.some(event => event.type === "error")).toBe(false);
        expect(await f.wait(token, 1)).toMatchObject({ kind: "result" });
        expect(f.session().roundBufferedTextCandidates(chatGptTurnRoundKey(next))).toEqual([candidate]);
        if (disconnected) {
          abort.abort();
          expect(await resultRun).toMatchObject({ name: "AbortError" });
        } else turn.onTextDelta(' and after tool."}', candidate);
        const ticket = await turn.completionFence!.begin(candidate);
        expect(await turn.completionFence!.commit(ticket!, candidate)).toBe(true);
        f.answer.resolve(answer);
        if (disconnected) {
          await f.session().browserOutcome;
          await f.session().physicalSettlement;
          await f.owner.waitForRetirement(token);
          await f.run(next, nextEvents);
        } else await resultRun;
        expect(nextEvents.filter(event => event.type === "text_delta" && event.phase === "final_answer")).toEqual([
          { type: "text_delta", text: answer, phase: "final_answer" },
        ]);
        expect(nextEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
        expect((await f.run(next)).filter(event => event.type !== "heartbeat")).toEqual(nextEvents.filter(event => event.type !== "heartbeat"));
        expect((await f.run(f.initial)).filter(event => event.type !== "heartbeat")).toEqual(sourceEvents.filter(event => event.type !== "heartbeat"));
        expect(f.submissions()).toBe(1);
      } finally { await f.close(); }
    });
  }

  for (const remote of [false, true]) for (const answer of [
    '{"answer":"Reconnect answer."}', '{"answer":42}', 'malformed JSON', 'Plain reconnect answer.',
  ]) {
    const structured = answer !== 'Plain reconnect answer.';
    const valid = answer === '{"answer":"Reconnect answer."}' || !structured;
    test(`${remote ? "Remote" : "Local"} completed disconnected round recovers ${answer}`, async () => {
      const f = await fixture({ remote, structured });
      try {
        const { token, turn, callId, events: sourceEvents } = await originalBatch(f);
        const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
        const abort = new AbortController();
        const consumed = deferred<void>();
        let textObserved = false;
        const firstEvents: AdapterEvent[] = [];
        const round = f.run(next, firstEvents, abort.signal, undefined, () => {
          if (textObserved) consumed.resolve();
        }).catch(error => error);
        const result = await f.wait(token, 1);
        await ack(f, token, result.taskUpdate!);
        await f.observing(1);
        const candidate = { expectedDriverGeneration: 1, taskRevision: 1, acknowledgedRevision: 1 };
        textObserved = true;
        turn.onTextDelta(answer, candidate);
        await consumed.promise;
        if (structured) expect(firstEvents.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
        abort.abort();
        expect(await round).toMatchObject({ name: "AbortError" });
        expect(f.session().runtime.text.drainWithContext()).toEqual([]);
        const ticket = await turn.completionFence!.begin(candidate);
        expect(await turn.completionFence!.commit(ticket!, candidate)).toBe(true);
        f.answer.resolve(answer);
        await f.session().browserOutcome;
        await f.session().physicalSettlement;
        await f.owner.waitForRetirement(token);
        expect(() => f.session().assertDriverGeneration(1)).toThrow();
        if (structured && valid) {
          const reconnectAbort = new AbortController();
          await expect(f.run(next, [], reconnectAbort.signal, event => {
            if (event.type === "text_delta" && event.phase === "final_answer") {
              reconnectAbort.abort();
              throw new DOMException("HTTP disconnected while sending the recovered answer", "AbortError");
            }
          })).rejects.toMatchObject({ name: "AbortError" });
          expect(f.session().roundCompleted(chatGptTurnRoundKey(next))).toBe(true);
          expect(f.session().roundEvents(chatGptTurnRoundKey(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
        }
        const events = await f.run(next);
        if (valid) {
          expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")).toEqual([
            { type: "text_delta", text: answer, phase: "final_answer" },
          ]);
          expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
        } else {
          expect(events.at(-1)).toMatchObject({ type: "error", code: "structured_output_validation_failed", retryable: false });
          expect(events.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
          expect(events.some(event => event.type === "done" && event.endTurn)).toBe(false);
        }
        expect((await f.run(next)).filter(event => event.type !== "heartbeat")).toEqual(events.filter(event => event.type !== "heartbeat"));
        expect((await f.run(f.initial)).filter(event => event.type !== "heartbeat")).toEqual(sourceEvents.filter(event => event.type !== "heartbeat"));
        const conflicting = structuredClone(next);
        (conflicting._rawBody as { input: Record<string, unknown>[] }).input.find(item => item.call_id === callId)!.output = "Changed result.";
        await expect(f.run(conflicting)).rejects.toMatchObject({ code: "task_update_driver_stale" });
        expect(f.submissions()).toBe(1);
      } finally { await f.close(); }
    });
  }

  for (const remote of [false, true]) test(`${remote ? "Remote" : "Local"} completed reconnect does not repeat strict text already journaled before disconnect`, async () => {
    const f = await fixture({ remote, structured: true });
    try {
      const { token, turn, callId } = await originalBatch(f);
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const abort = new AbortController();
      const round = f.run(next, [], abort.signal, event => {
        if (event.type === "text_delta" && event.phase === "final_answer") {
          abort.abort();
          throw new DOMException("HTTP disconnected before done", "AbortError");
        }
      }).catch(error => error);
      const result = await f.wait(token, 1);
      await ack(f, token, result.taskUpdate!);
      await f.observing(1);
      const candidate = { expectedDriverGeneration: 1, taskRevision: 1, acknowledgedRevision: 1 };
      const ticket = await turn.completionFence!.begin(candidate);
      expect(await turn.completionFence!.commit(ticket!, candidate)).toBe(true);
      const answer = '{"answer":"Already journaled answer."}';
      await f.finish(token, turn, answer, candidate);
      expect(await round).toMatchObject({ name: "AbortError" });
      expect(f.session().roundHasTerminalEvent(chatGptTurnRoundKey(next))).toBe(false);
      await f.session().physicalSettlement;
      await f.owner.waitForRetirement(token);
      const events = await f.run(next);
      expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")).toEqual([
        { type: "text_delta", text: answer, phase: "final_answer" },
      ]);
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect((await f.run(next)).filter(event => event.type !== "heartbeat")).toEqual(events.filter(event => event.type !== "heartbeat"));
      expect(f.submissions()).toBe(1);
    } finally { await f.close(); }
  });

  for (const remote of [false, true]) test(`${remote ? "Remote" : "Local"} completed reconnect cannot take another round's answer at the same task version`, async () => {
    const f = await fixture({ remote });
    try {
      const { token, turn, callId } = await originalBatch(f);
      const first = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const abort = new AbortController();
      const firstRun = f.run(first, [], abort.signal).catch(error => error);
      const result = await f.wait(token, 1);
      await ack(f, token, result.taskUpdate!);
      await f.observing(1);
      abort.abort();
      expect(await firstRun).toMatchObject({ name: "AbortError" });
      expect(f.session().roundEvents(chatGptTurnRoundKey(first))).toEqual([]);
      const second = structuredClone(first);
      (second._rawBody as { input: unknown[] }).input.push({ type: "message", id: "assistant-observer", role: "assistant",
        content: [{ type: "output_text", text: "Observer continuation context." }] });
      second.context.messages.push({ role: "assistant", content: [{ type: "text", text: "Observer continuation context." }], timestamp: 9 });
      expect(chatGptTurnRoundKey(second)).not.toBe(chatGptTurnRoundKey(first));
      const observingSecond = deferred<void>();
      const nextBatch = f.owner.nextToolBatch.bind(f.owner);
      f.owner.nextToolBatch = (capability, signal, context) => {
        observingSecond.resolve();
        return nextBatch(capability, signal, context);
      };
      const secondRun = f.run(second);
      await observingSecond.promise;
      const candidate = { expectedDriverGeneration: 1, taskRevision: 1, acknowledgedRevision: 1 };
      const answer = "Answer belongs to the second accepted round.";
      turn.onTextDelta(answer, candidate);
      const ticket = await turn.completionFence!.begin(candidate);
      expect(await turn.completionFence!.commit(ticket!, candidate)).toBe(true);
      f.answer.resolve(answer);
      const secondEvents = await secondRun;
      expect(secondEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
      await f.session().physicalSettlement;
      await f.owner.waitForRetirement(token);
      const firstEvents = await f.run(first);
      expect(firstEvents.at(-1)).toMatchObject({ type: "error", code: "task_update_driver_stale" });
      expect(firstEvents.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
      expect(firstEvents.some(event => event.type === "done" && event.endTurn)).toBe(false);
      expect((await f.run(second)).filter(event => event.type !== "heartbeat")).toEqual(secondEvents.filter(event => event.type !== "heartbeat"));
      expect(f.submissions()).toBe(1);
    } finally { await f.close(); }
  });

  for (const remote of [false, true]) for (const stage of ["buffered", "completion committed", "retired"]) {
    test(`${remote ? "Remote" : "Local"} non-owning reconnect preserves the owning strict answer while ${stage}`, async () => {
      const f = await fixture({ remote, structured: true });
      try {
        const { token, turn, callId } = await originalBatch(f);
        const first = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
        const abortFirst = new AbortController();
        const firstRun = f.run(first, [], abortFirst.signal).catch(error => error);
        const result = await f.wait(token, 1);
        await ack(f, token, result.taskUpdate!);
        await f.observing(1);
        abortFirst.abort();
        expect(await firstRun).toMatchObject({ name: "AbortError" });
        const second = structuredClone(first);
        (second._rawBody as { input: unknown[] }).input.push({ type: "message", id: "assistant-observer", role: "assistant",
          content: [{ type: "output_text", text: "Observer continuation context." }] });
        second.context.messages.push({ role: "assistant", content: [{ type: "text", text: "Observer continuation context." }], timestamp: 9 });
        const observingSecond = deferred<void>();
        const nextBatch = f.owner.nextToolBatch.bind(f.owner);
        f.owner.nextToolBatch = (capability, signal, context) => {
          observingSecond.resolve();
          return nextBatch(capability, signal, context);
        };
        const abortSecond = new AbortController();
        const consumed = deferred<void>();
        let textObserved = false;
        const secondRun = f.run(second, [], abortSecond.signal, undefined, () => {
          if (textObserved) consumed.resolve();
        }).catch(error => error);
        await observingSecond.promise;
        const candidate = { expectedDriverGeneration: 1, taskRevision: 1, acknowledgedRevision: 1 };
        const answer = '{"answer":"Only the owning round can recover this answer."}';
        textObserved = true;
        turn.onTextDelta(answer, candidate);
        await consumed.promise;
        abortSecond.abort();
        expect(await secondRun).toMatchObject({ name: "AbortError" });
        const complete = async () => {
          const ticket = await turn.completionFence!.begin(candidate);
          expect(await turn.completionFence!.commit(ticket!, candidate)).toBe(true);
        };
        if (stage !== "buffered") await complete();
        if (stage === "retired") {
          f.answer.resolve(answer);
          await f.session().browserOutcome;
          await f.session().physicalSettlement;
          await f.owner.waitForRetirement(token);
        } else expect(f.session().settledOutcome()).toBeUndefined();
        const rejection = await f.run(first);
        expect(rejection.at(-1)).toMatchObject({ type: "error", code: "task_update_driver_stale" });
        expect(rejection.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
        expect(rejection.some(event => event.type === "done" && event.endTurn)).toBe(false);
        expect(f.session().isTaskUpdateCancelled()).toBe(false);
        expect((await f.run(first)).at(-1)).toEqual(rejection.at(-1)!);
        if (stage === "buffered") await complete();
        if (stage !== "retired") {
          f.answer.resolve(answer);
          await f.session().browserOutcome;
          await f.session().physicalSettlement;
          await f.owner.waitForRetirement(token);
        }
        const recovered = await f.run(second);
        expect(recovered.filter(event => event.type === "text_delta" && event.phase === "final_answer")).toEqual([
          { type: "text_delta", text: answer, phase: "final_answer" },
        ]);
        expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
        expect((await f.run(second)).filter(event => event.type !== "heartbeat")).toEqual(recovered.filter(event => event.type !== "heartbeat"));
        expect(f.submissions()).toBe(1);
      } finally { await f.close(); }
    });
  }

  for (const remote of [false, true]) test(`${remote ? "Remote" : "Local"} completed reconnect retains completion when an earlier output-start reply arrives late`, async () => {
    const f = await fixture({ remote });
    const release = deferred<void>();
    try {
      const { token, turn, callId } = await originalBatch(f);
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const started = deferred<void>();
      const begin = f.owner.beginFinalOutput!.bind(f.owner);
      f.owner.beginFinalOutput = async (...args) => {
        const receipt = await begin(...args);
        expect(receipt.kind).toBe("output_started");
        started.resolve();
        await release.promise;
        return receipt;
      };
      const abort = new AbortController();
      const round = f.run(next, [], abort.signal, event => {
        if (event.type === "text_delta" && event.phase === "final_answer") {
          abort.abort();
          throw new DOMException("HTTP disconnected before done", "AbortError");
        }
      }).catch(error => error);
      const result = await f.wait(token, 1);
      await ack(f, token, result.taskUpdate!);
      await f.observing(1);
      const candidate = { expectedDriverGeneration: 1, taskRevision: 1, acknowledgedRevision: 1 };
      const answer = "Completed answer with a delayed output-start reply.";
      turn.onTextDelta(answer, candidate);
      await started.promise;
      const ticket = await turn.completionFence!.begin(candidate);
      expect(await turn.completionFence!.commit(ticket!, candidate)).toBe(true);
      const completed = f.session().runtime.taskUpdates!.outputReceipt;
      expect(completed?.kind).toBe("completed");
      f.answer.resolve(answer);
      await f.session().browserOutcome;
      release.resolve();
      expect(await round).toMatchObject({ name: "AbortError" });
      expect(f.session().runtime.taskUpdates!.outputReceipt).toEqual(completed);
      await f.session().physicalSettlement;
      await f.owner.waitForRetirement(token);
      const events = await f.run(next);
      expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")).toEqual([
        { type: "text_delta", text: answer, phase: "final_answer" },
      ]);
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect((await f.run(next)).filter(event => event.type !== "heartbeat")).toEqual(events.filter(event => event.type !== "heartbeat"));
      expect(f.submissions()).toBe(1);
    } finally { release.resolve(); await f.close(); }
  });

  for (const remote of [false, true]) for (const failure of ["cancelled", "unacknowledged", "old version"]) {
    test(`${remote ? "Remote" : "Local"} completed reconnect rejects ${failure}`, async () => {
      const f = await fixture({ remote, structured: true });
      try {
        const { token, turn, callId } = await originalBatch(f);
        const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
        const abort = new AbortController();
        const round = f.run(next, [], abort.signal).catch(error => error);
        const result = await f.wait(token, 1);
        await ack(f, token, result.taskUpdate!);
        await f.observing(1);
        abort.abort();
        expect(await round).toMatchObject({ name: "AbortError" });
        const candidate = { expectedDriverGeneration: 1, taskRevision: 1, acknowledgedRevision: 1 };
        const ticket = await turn.completionFence!.begin(candidate);
        expect(await turn.completionFence!.commit(ticket!, candidate)).toBe(true);
        const answer = '{"answer":"Rejected reconnect answer."}';
        turn.onTextDelta(answer, failure === "unacknowledged" ? { ...candidate, acknowledgedRevision: 0 }
          : failure === "old version" ? { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 } : candidate);
        f.answer.resolve(answer);
        await f.session().browserOutcome;
        await f.session().physicalSettlement;
        await f.owner.waitForRetirement(token);
        if (failure === "cancelled") f.session().cancel();
        const events = await f.run(next);
        expect(events.at(-1)).toMatchObject({ type: "error", retryable: false,
          code: failure === "cancelled" ? "task_update_driver_stale"
            : failure === "unacknowledged" ? "task_update_unacknowledged" : "task_update_output_stale" });
        expect(events.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
        expect(events.some(event => event.type === "done" && event.endTurn)).toBe(false);
        expect((await f.run(next)).at(-1)).toEqual(events.at(-1)!);
        expect(f.submissions()).toBe(1);
      } finally { await f.close(); }
    });
  }

  for (const remote of [false, true]) test(`${remote ? "Remote" : "Local"} a delayed strict admission rejection survives a successful late ACK`, async () => {
    const f = await fixture({ structured: true, remote });
    const release = deferred<void>();
    try {
      const { token, turn, callId } = await originalBatch(f);
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const events: AdapterEvent[] = [];
      const round = f.run(next, events);
      const result = await f.wait(token, 1);
      await f.observing(1);
      const checked = deferred<void>();
      const check = f.owner.checkFinalOutputCandidate.bind(f.owner);
      f.owner.checkFinalOutputCandidate = async (capability, candidate) => {
        let failure: unknown;
        try { await check(capability, candidate); } catch (error) { failure = error; }
        checked.resolve();
        // Hold only the response, after the actual Broker has made its admission decision.
        await release.promise;
        if (failure) throw failure;
      };
      const candidate = { expectedDriverGeneration: 1, taskRevision: 1 };
      turn.onTextDelta('{"answer":"Unacknowledged answer."}', candidate);
      await checked.promise;
      expect(await ack(f, token, result.taskUpdate!)).toMatchObject({ acknowledgedRevision: 1 });
      expect(f.broker.taskUpdateState(token)?.finalOutputRevision).toBeNull();
      const ticket = await f.owner.beginCompletionFence(token, candidate);
      expect(ticket).toBeNumber();
      const begin = turn.completionFence!.begin(candidate).catch(error => error);
      const commit = turn.completionFence!.commit(ticket!, candidate).catch(error => error);
      release.resolve();
      expect(await begin).toMatchObject({ code: "task_update_unacknowledged" });
      expect(await commit).toMatchObject({ code: "task_update_unacknowledged" });
      await round;
      expect(events.at(-1)).toMatchObject({ type: "error", code: "task_update_unacknowledged", retryable: false });
      expect(events.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
      expect(events.some(event => event.type === "done" && event.endTurn)).toBe(false);
    } finally { release.resolve(); await f.close(); }
  });

  test("Remote strict text stays rejected when its actual IPC check request reaches Broker after ACK", async () => {
    const f = await fixture({ structured: true, remote: true });
    const received = deferred<void>();
    const release = deferred<void>();
    const connections = new Set<Socket>();
    const proxyPath = join(testRoot, "strict-admission-proxy.sock");
    const proxy = createServer(client => {
      connections.add(client);
      client.on("error", () => {});
      client.on("close", () => connections.delete(client));
      let frame = "";
      client.setEncoding("utf8");
      client.on("data", chunk => {
        frame += chunk;
        if (!frame.includes("\n")) return;
        const request = frame;
        frame = "";
        expect(JSON.parse(request).method).toBe("owner_final_output_check");
        received.resolve();
        // Delay request forwarding, rather than a response from a Broker that already checked.
        void release.promise.then(() => {
          const upstream = createConnection(f.socket);
          connections.add(upstream);
          upstream.on("error", error => client.destroy(error));
          upstream.on("close", () => connections.delete(upstream));
          upstream.once("connect", () => upstream.write(request));
          upstream.pipe(client);
        });
      });
    });
    await new Promise<void>(resolve => proxy.listen(proxyPath, resolve));
    const delayedOwner = new RemoteTurnBroker(proxyPath);
    f.owner.checkFinalOutputCandidate = delayedOwner.checkFinalOutputCandidate.bind(delayedOwner);
    try {
      const { token, turn, callId } = await originalBatch(f);
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const events: AdapterEvent[] = [];
      const round = f.run(next, events);
      const result = await f.wait(token, 1);
      await f.observing(1);
      const candidate = { expectedDriverGeneration: 1, taskRevision: 1 };
      expect(f.broker.taskUpdateState(token)).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 0 });
      turn.onTextDelta('{"answer":"Unacknowledged answer."}', candidate);
      await received.promise;
      expect(await ack(f, token, result.taskUpdate!)).toMatchObject({ acknowledgedRevision: 1 });
      const begin = turn.completionFence!.begin(candidate).catch(error => error);
      release.resolve();
      const resultOfBegin = await begin;
      if (typeof resultOfBegin === "number") await turn.completionFence!.commit(resultOfBegin, candidate);
      f.answer.resolve('{"answer":"Unacknowledged answer."}');
      await round;
      expect(events.at(-1)).toMatchObject({ type: "error", code: "task_update_unacknowledged", retryable: false });
      expect(events.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
      expect(events.some(event => event.type === "done" && event.endTurn)).toBe(false);
      expect(resultOfBegin).toMatchObject({ code: "task_update_unacknowledged" });
      expect((await f.run(next)).at(-1)).toEqual(events.at(-1)!);
      expect(f.submissions()).toBe(1);
    } finally {
      release.resolve();
      for (const connection of connections) connection.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      await f.close();
    }
  });

  for (const remote of [false, true]) test(`${remote ? "Remote" : "Local"} a completion receipt cannot upgrade a candidate captured before ACK`, async () => {
    const f = await fixture({ structured: true, remote });
    try {
      const { token, turn, callId } = await originalBatch(f);
      const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
      const events: AdapterEvent[] = [];
      const round = f.run(next, events);
      const result = await f.wait(token, 1);
      await ack(f, token, result.taskUpdate!);
      const confirmed = { expectedDriverGeneration: 1, taskRevision: 1, acknowledgedRevision: 1 };
      const ticket = await turn.completionFence!.begin(confirmed);
      expect(await turn.completionFence!.commit(ticket!, confirmed)).toBe(true);
      turn.onTextDelta('{"answer":"Unacknowledged answer."}', { ...confirmed, acknowledgedRevision: 0 });
      f.answer.resolve('{"answer":"Unacknowledged answer."}');
      await round;
      expect(events.at(-1)).toMatchObject({ type: "error", code: "task_update_unacknowledged", retryable: false });
      expect(events.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
      expect(events.some(event => event.type === "done" && event.endTurn)).toBe(false);
    } finally { await f.close(); }
  });

  for (const remote of [false, true]) for (const answer of ['{"answer":"Validated answer."}', '{"answer":42}', 'malformed JSON']) {
    const valid = answer === '{"answer":"Validated answer."}';
    test(`${remote ? "Remote" : "Local"} strict buffered text keeps the update window open and ${valid ? "sends valid JSON" : `rejects ${answer}`}`, async () => {
      const f = await fixture({ structured: true, remote });
      try {
        const { token, turn, callId } = await originalBatch(f);
        const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
        const events: AdapterEvent[] = [];
        const consumed = deferred<void>();
        let textObserved = false;
        const round = f.run(next, events, undefined, undefined, () => {
          if (textObserved) consumed.resolve();
        });
        const result = await f.wait(token, 1);
        await ack(f, token, result.taskUpdate!);
        await f.observing(1);
        const candidate = { expectedDriverGeneration: 1, taskRevision: 1, acknowledgedRevision: 1 };
        textObserved = true;
        turn.onTextDelta(answer, candidate);
        await consumed.promise;
        expect(events.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
        expect(f.broker.taskUpdateState(token)?.finalOutputRevision).toBeNull();
        const ticket = await turn.completionFence!.begin(candidate);
        expect(ticket).toBeNumber();
        expect(await turn.completionFence!.commit(ticket!, candidate)).toBe(true);
        expect(f.broker.taskUpdateState(token)?.finalOutputRevision).toBe(1);
        f.answer.resolve(answer);
        await round;
        if (valid) {
          expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")).toEqual([
            { type: "text_delta", text: answer, phase: "final_answer" },
          ]);
          expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
        } else {
          expect(events.at(-1)).toMatchObject({ type: "error", code: "structured_output_validation_failed", retryable: false });
          expect(events.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
          expect(events.some(event => event.type === "done" && event.endTurn)).toBe(false);
        }
      } finally { await f.close(); }
    });
  }
});


function directBrowserFixture(readText: () => Promise<string>, onSourceBoundary?: () => void) {
  const root = mkdtempSync(join(testRoot, "direct-"));

  const worker = ChatGptBrowserWorker.forProvider({
    adapter: "chatgpt-web", baseUrl: `browser://${root}`,
    chatgptWeb: { appName: "Codex Native4", browserDiagnosticsPath: root },
  }) as any;
  const hidden: any = {
    last: () => hidden, filter: () => hidden, getByText: () => hidden, getByTestId: () => hidden,
    isVisible: async () => false,
  };
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false, locator: () => hidden, url: () => "https://chatgpt.com/",
    evaluate: async () => { throw new Error("DOM supplied by the owned-turn fixture"); },
  });
  let observations = 0;
  Object.assign(worker, {
    prepareChatSurface: async () => {},
    selectModelAndEffort: async () => ({ effort: "low", localTools: false }),
    captureSubmissionBaseline: async () => ({}),
    attachPromptWithCompactionRetry: async () => {}, attachFiles: async () => {},
    sendAttachedPrompt: async (_page: unknown, _baseline: unknown, _capture: unknown, _signal: unknown,
      progress: ChatGptExternalTurnProgress, _lifecycle: unknown, tracker: ChatGptCompletionTracker) => {
      const snapshot = progress.snapshot();
      if (snapshot.lastToolBatchRevision) {
        tracker.observeToolBatch(snapshot.lastToolBatchRevision, "Before tool");
        await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
      }
      onSourceBoundary?.();
      return "mcp_tool_call";
    },
    waitForNewAssistantTurn: async () => ({ locator: hidden, identity: "assistant", acceptedTurnIdentities: ["assistant"] }),
    responseDomSnapshot: async () => {
      observations += 1;
      const text = await readText();
      return {
        responsePresent: true, visibleText: text, fullHtml: `<p>${text}</p>`,
        markdownSegments: [{ key: "answer", tag: "p", html: `<p>${text}</p>`, text, streamable: true }],
        completionActionVisible: true, stoppedThinkingVisible: false, traceBlocks: [],
      };
    },
  });
  return {
    run: (turn: Pick<BrowserTurn, "externalProgress" | "completionFence" | "onTextDelta">) => worker.runBrowserTurn({
      ...turn, traceId: "task_update_direct", modelId: "gpt-5.6-sol", reasoning: "low", taskUpdateProtocol: 1,
      capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      prepare: async () => ({ text: "inspect", images: [], release() {} }),
    }, undefined, page) as Promise<string>,
    observations: () => observations,
  };
}


test("Remote strict answer generated after real ACK succeeds while its owner state response is delayed", async () => {
  const f = await fixture({ remote: true, structured: true });
  const release = deferred<void>();
  const ackSnapshotWaiting = deferred<void>();
  const proxySocket = join(testRoot, "delayed-owner-observe.sock");
  const connections = new Set<Socket>();
  const proxy = createServer(client => {
    connections.add(client);
    client.setEncoding("utf8");
    client.on("error", () => {});
    client.on("close", () => connections.delete(client));
    let frame = "";
    let handled = false;
    client.on("data", chunk => {
      frame += chunk;
      if (handled || !frame.includes("\n")) return;
      handled = true;
      const message = JSON.parse(frame.slice(0, frame.indexOf("\n")));
      expect(message.method).toBe("owner_task_update_observe");
      const upstream = createConnection(f.socket);
      connections.add(upstream);
      upstream.setEncoding("utf8");
      upstream.on("error", error => client.destroy(error));
      upstream.on("close", () => connections.delete(upstream));
      upstream.once("connect", () => upstream.write(frame));
      let response = "";
      upstream.on("data", chunk => {
        response += chunk;
        if (!response.includes("\n")) return;
        const parsed = JSON.parse(response.slice(0, response.indexOf("\n")));
        if (parsed.result?.state?.acknowledgedRevision === 1) {
          ackSnapshotWaiting.resolve();
          void release.promise.then(() => client.end(response));
        } else client.end(response);
      });
    });
  });
  await new Promise<void>(resolve => proxy.listen(proxySocket, resolve));
  const delayedOwner = new RemoteTurnBroker(proxySocket);
  f.owner.waitForTaskUpdateState = delayedOwner.waitForTaskUpdateState.bind(delayedOwner);
  try {
    const { token, turn, callId } = await originalBatch(f);
    const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
    const events: AdapterEvent[] = [];
    const round = f.run(next, events);
    const result = await f.wait(token, 1);
    await f.observing(1);
    expect(await ack(f, token, result.taskUpdate!)).toMatchObject({ acknowledgedRevision: 1 });
    await ackSnapshotWaiting.promise;
    expect(f.broker.taskUpdateState(token)).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 1 });
    expect(turn.externalProgress!.snapshot().taskUpdates).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 0 });
    const answer = '{"answer":"Generated after successful ACK."}';
    const browser = directBrowserFixture(async () => answer);
    const observed: unknown[] = [];
    const browserResult = await browser.run({
      externalProgress: turn.externalProgress,
      completionFence: turn.completionFence,
      onTextDelta: (text, candidate) => { observed.push(candidate); turn.onTextDelta(text, candidate); },
    }).catch(error => error);
    release.resolve();
    if (browserResult instanceof Error) f.answer.reject(browserResult); else f.answer.resolve(browserResult);
    await round;
    expect(observed[0]).toMatchObject({ taskRevision: 1, expectedDriverGeneration: 1, acknowledgedRevision: 1 });
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")).toEqual([
      { type: "text_delta", text: answer, phase: "final_answer" },
    ]);
  } finally {
    release.resolve();
    for (const connection of connections) connection.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await f.close();
  }
});


import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
// Budget includes helper startup (up to 15 seconds), the real DOM settle loop, and cleanup.
const REAL_HELPER_TIMEOUT_MS = 30_000;
const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function realHelperClient(browserFixture: string): LauncherBrowserHelperClient {
  const root = mkdtempSync(join(tmpdir(), "task-update-browser-helper-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  writeFileSync(helper, `
    import { observedTaskAcknowledgement } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/task-update-ack.ts", import.meta.url).href)};
    import { ChatGptBrowserWorker, ChatGptCompletionTracker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      if (turn.taskUpdateProtocol !== 1) throw new Error("Task update protocol lost in IPC");
      await turn.onPreparedSelected(false);
      await turn.prepare();
      await turn.onSendActivated();
      ${browserFixture}
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const descriptor = join(root, "launcher.json");
  writeFileSync(descriptor, JSON.stringify({
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: { endpoint: "http://127.0.0.1:39002", token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { launcher_surface_id_0123456789AB: "native-owned-target" },
    createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  return new LauncherBrowserHelperClient({
    appName: "Codex Native4", browserHost: "launcher", browserHostDescriptorPath: descriptor,
    browserHelperScriptPath: helper, browserDiagnosticsPath: root,
    storageStatePath: join(root, "unused-state.json"), chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000, headed: true, autoApproveToolCalls: false, useSavedChats: false,
  });
}


test("Remote strict answer after ACK succeeds when the real helper receives its entire version frame late", async () => {
  const f = await fixture({ remote: true, structured: true });
  const gatePath = join(testRoot, "real-ack-before-dom-read");
  const answer = '{"answer":"New answer after acknowledged update."}';
  const helper = realHelperClient(`
    const fs = await import("node:fs");
    const { EventEmitter } = await import("node:events");
    let snapshot = turn.externalProgress.snapshot();
    if (!snapshot.taskUpdates) snapshot = await turn.externalProgress.waitForChange(snapshot.revision, turn.abortSignal);
    if (snapshot.taskUpdates.acceptedRevision !== 0 || snapshot.taskUpdates.driverGeneration !== 0) throw new Error("Need actual initial progress");
    turn.onSubmitted();
    while (!fs.existsSync(${JSON.stringify(gatePath)})) await new Promise(resolve => setTimeout(resolve, 10));
    snapshot = turn.externalProgress.snapshot();
    if (snapshot.taskUpdates.acceptedRevision !== 0 || snapshot.taskUpdates.driverGeneration !== 0) throw new Error("Delayed whole progress frame unexpectedly arrived");
    const hidden = { last: () => hidden, filter: () => hidden, getByText: () => hidden, getByTestId: () => hidden, isVisible: async () => false };
    const page = Object.assign(new EventEmitter(), { isClosed: () => false, locator: () => hidden, url: () => "https://chatgpt.com/", evaluate: async () => { throw new Error("Controlled DOM fixture"); } });
    Object.assign(this, {
      prepareChatSurface: async () => {}, selectModelAndEffort: async () => ({ effort: "low", localTools: false }),
      captureSubmissionBaseline: async () => ({}), attachPromptWithCompactionRetry: async () => {}, attachFiles: async () => {},
      sendAttachedPrompt: async (_page, _baseline, _capture, _signal, progress, _lifecycle, tracker) => {
        const current = progress.snapshot();
        if (current.lastToolBatchRevision) { tracker.observeToolBatch(current.lastToolBatchRevision, "Before tool"); await progress.acknowledgeToolBatch(current.lastToolBatchRevision); }
        return "mcp_tool_call";
      },
      waitForNewAssistantTurn: async () => ({ locator: hidden, identity: "assistant", acceptedTurnIdentities: ["assistant"] }),
      responseDomSnapshot: async () => ({ responsePresent: true, visibleText: ${JSON.stringify(answer)}, fullHtml: '<p>New answer</p>', markdownSegments: [{ key: "answer", tag: "p", html: ${JSON.stringify('<p>'+answer+'</p>')}, text: ${JSON.stringify(answer)}, streamable: true }], completionActionVisible: true, stoppedThinkingVisible: false, traceBlocks: [] }),
    });
    return await this.runBrowserTurn({ ...turn, modelId: "gpt-5.6-sol", reasoning: "low", capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false } }, undefined, page);
  `);
  const helperReady = deferred<void>();
  const wholeFrameQueued = deferred<void>();
  const release = deferred<void>();
  const internal = helper as any;
  const originalSend = internal.send.bind(internal);
  internal.send = async (message: any) => {
    if (message.type === "progress" && message.snapshot?.taskUpdates?.acceptedRevision > 0) {
      wholeFrameQueued.resolve();
      await release.promise;
    }
    return originalSend(message);
  };
  let helperResult: Promise<unknown> | undefined;
  try {
    const { token, turn, callId } = await originalBatch(f);
    const seen: unknown[] = [];
    helperResult = helper.run({ ...turn,
      traceId: "actual_helper_delayed_full_revision",
      onSubmitted: () => { turn.onSubmitted?.(); helperReady.resolve(); },
      onTextDelta: (text, candidate) => { seen.push(candidate); turn.onTextDelta(text, candidate); release.resolve(); },
    }).catch(error => error);
    void helperResult.then(outcome => { if (outcome instanceof Error) f.answer.reject(outcome); else f.answer.resolve(outcome as string); });
    await helperReady.promise;
    const next = append(f.initial, callId, [{ id: "update-1", text: "Include validation." }]);
    const events: AdapterEvent[] = [];
    const round = f.run(next, events);
    const result = await f.wait(token, 1);
    await wholeFrameQueued.promise;
    expect(await ack(f, token, result.taskUpdate!)).toMatchObject({ acknowledgedRevision: 1 });
    expect(f.broker.taskUpdateState(token)).toMatchObject({ acceptedRevision: 1, driverGeneration: 1, acknowledgedRevision: 1 });
    writeFileSync(gatePath, "ACK succeeded before DOM loop starts");
    await round;
    expect(seen[0]).toMatchObject({ taskRevision: 1, expectedDriverGeneration: 1, acknowledgedRevision: 1 });
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")).toEqual([{ type: "text_delta", text: answer, phase: "final_answer" }]);
  } finally {
    release.resolve();
    await f.close();
    await helperResult;
    await helper.close();
  }
}, REAL_HELPER_TIMEOUT_MS);
