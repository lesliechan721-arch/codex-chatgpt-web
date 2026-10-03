import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnExecutionKey, chatGptTurnRoundKey, chatGptTurnSessions,
  TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES, TASK_UPDATE_SESSION_JOURNAL_BYTES } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { NativeOperationReply } from "../src/adapters/chatgpt-web/native-tool-operations";
import type { TaskUpdateAckResult, UpdateDelivery } from "../src/adapters/chatgpt-web/task-update-protocol";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig, CodexTool } from "../src/types";

const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-safe-updates-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
const nativeResult = "  unchanged Native result\n";
const tools: CodexTool[] = [{ name: "exec_command", description: "An inert outer command fixture", parameters: { type: "object" } }];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function request(scope: string): CodexParsedRequest {
  const turnId = `turn-${scope}`;
  return {
    modelId: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, stream: true, options: { reasoning: "low" },
    context: { tools, messages: [{ role: "user", content: "Inspect the project.", timestamp: 1 }] },
    _rawBody: {
      instructions: "Preserve higher-priority instructions.", prompt_cache_key: `thread-${scope}`,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `thread-${scope}`, turn_id: turnId }) },
      input: [{ type: "message", id: "initial-user", role: "user", content: [{ type: "input_text", text: "Inspect the project." }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["user.text"] } }],
    },
  };
}

function append(original: CodexParsedRequest, update: { id: string; text: string }, callId?: string): CodexParsedRequest {
  const next = structuredClone(original);
  const raw = next._rawBody as { input: Record<string, unknown>[] };
  const turnId = (raw.input[0]!.internal_chat_message_metadata_passthrough as { turn_id: string }).turn_id;
  if (callId && !raw.input.some(item => item.type === "function_call_output" && item.call_id === callId)) {
    raw.input.push({ type: "function_call_output", call_id: callId, output: nativeResult });
    next.context.messages.push({ role: "toolResult", toolCallId: callId, toolName: "exec_command", content: nativeResult, isError: false, timestamp: 2 });
  }
  raw.input.push({ type: "message", id: update.id, role: "user", content: [{ type: "input_text", text: update.text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["user.text"] } });
  next.context.messages.push({ role: "user", content: update.text, timestamp: next.context.messages.length + 1 });
  return next;
}

function binding(prompt: string): string {
  const json = prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)\n<\/codex_zero_risk_request_json>/)?.[1];
  if (!json) throw new Error("The manual prompt lost its request_id");
  return (JSON.parse(json) as { request_id: string }).request_id;
}

async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function toolCall(events: AdapterEvent[]): Extract<AdapterEvent, { type: "tool_call_start" }> {
  const call = events.find(event => event.type === "tool_call_start");
  if (call?.type !== "tool_call_start") throw new Error("The source round did not emit a Native tool call");
  return call;
}

async function fixture(options: { remote?: boolean; awaitingSent?: boolean } = {}) {
  const scope = `safe-update-${++sequence}`;
  const socket = defaultBrokerEndpoint(join(root, scope));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `manual://${scope}`,
    chatgptWeb: {
      appName: "Codex Zero Risk3", browserInteractionMode: "manual", browserHost: "launcher",
      browserHostDescriptorPath: join(root, `${scope}-launcher.json`), brokerSocketPath: socket,
      localToolsEnabled: true, toolAuthorityMode: "delegated", solAvailable: false,
      extraHighAvailable: false, proAvailable: false, experimentalBiggerContext: false,
    },
  };
  const broker = TurnBroker.forSocket(socket);
  if (options.remote) await broker.listen();
  const owner = options.remote ? new RemoteTurnBroker(socket) : broker;
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  let automaticStarts = 0;
  worker.run = async () => { automaticStarts += 1; throw new Error("Zero Risk must not run the automatic worker"); };
  const starts: { traceId: string; requestId: string; prompt: string; sent: ReturnType<typeof deferred<void>> }[] = [];
  const started: string[] = [];
  const ends: { traceId: string; status: string }[] = [];
  const cancels: string[] = [];
  const running = deferred<string>();
  const control: ChatGptZeroRiskManualControl = {
    async start(_descriptor, activity) {
      const start = { traceId: activity.traceId, requestId: binding(activity.prompt), prompt: activity.prompt, sent: deferred<void>() };
      starts.push(start);
      if (!options.awaitingSent) start.sent.resolve();
    },
    async waitSent(_descriptor, activity, settings) {
      const start = starts.find(value => value.traceId === activity.traceId)!;
      await new Promise<void>((resolve, reject) => {
        const signal = settings?.abortSignal;
        const aborted = () => reject(new DOMException("manual Sent wait aborted", "AbortError"));
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) aborted();
        start.sent.promise.then(() => { signal?.removeEventListener("abort", aborted); resolve(); });
      });
      broker.startSafeTurn(start.requestId);
    },
    waitTerminal: () => new Promise<never>(() => {}),
    async markStarted(_descriptor, activity) {
      const requestId = starts.find(value => value.traceId === activity.traceId)!.requestId;
      started.push(requestId);
      running.resolve(requestId);
    },
    async end(_descriptor, activity) { ends.push({ traceId: activity.traceId, status: activity.status }); },
    async cancel(_descriptor, activity) { cancels.push(activity.traceId); },
  };
  const adapter = createChatGptWebAdapter(provider, { broker: owner, zeroRiskManualControl: control });
  const activeRuns = new Set<Promise<void>>();
  const run = (parsed: CodexParsedRequest, events: AdapterEvent[], abortSignal?: AbortSignal) => {
    const promise = adapter.runTurn!(parsed, { headers: new Headers(), ...(abortSignal ? { abortSignal } : {}) }, event => events.push(event));
    activeRuns.add(promise);
    void promise.finally(() => activeRuns.delete(promise)).catch(() => {});
    return promise;
  };
  const start = (requestId: string, operationId = 1) => callTurnBroker<NativeOperationReply>(socket, {
    method: "native_operation_start", token: requestId, contract: "safe", nativeWaitProtocol: 1,
    taskUpdateProtocol: 1, taskRevision: 0, operationId, entry: "codex_exec", nativeInput: { cmd: "inert fixture" }, waitMs: 1,
  }, 5_000);
  const wait = (requestId: string, operationId = 1) => callTurnBroker<NativeOperationReply>(socket, {
    method: "native_operation_wait", token: requestId, contract: "safe", nativeWaitProtocol: 1, operationId, waitMs: 1,
  }, 5_000);
  const ack = (requestId: string, delivery: UpdateDelivery) => callTurnBroker<TaskUpdateAckResult>(socket, {
    method: "task_update_ack", token: requestId, contract: "safe", taskUpdateProtocol: 1,
    deliveryId: delivery.deliveryId, throughRevision: delivery.throughRevision,
  }, 5_000);
  const complete = (requestId: string, taskRevision: number, finalAnswer: string) => callTurnBroker(socket, {
    method: "safe_complete", token: requestId, taskUpdateProtocol: 1, taskRevision, finalAnswer,
  }, 5_000);
  const initial = request(scope);
  return {
    broker, socket, starts, started, ends, cancels, initial, run, start, wait, ack, complete,
    session: () => chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(initial)}`)!,
    ready: running.promise, automaticStarts: () => automaticStarts,
    close: async () => {
      chatGptTurnSessions.clear();
      await Promise.allSettled([...activeRuns]);
      await Promise.allSettled(starts.map(start => broker.waitForRetirement(start.requestId, AbortSignal.timeout(1_000))));
      await broker.close();
      worker.run = originalRun;
    },
  };
}

describe("Zero Risk Adapter task updates", () => {
  for (const remote of [false, true]) test(`${remote ? "Remote" : "Local"} owner preserves the manual request across a result, trusted append, ACK and complete answer`, async () => {
    const f = await fixture({ remote });
    try {
      const sourceEvents: AdapterEvent[] = [];
      const sourceRound = f.run(f.initial, sourceEvents);
      const requestId = await f.ready;
      expect(f.starts[0]!.prompt).toContain('"protocol":"task-updates-v1","task_revision":0');
      expect(await f.start(requestId)).toMatchObject({ kind: "pending", operation_id: 1 });
      await sourceRound;
      const call = toolCall(sourceEvents);
      expect(sourceEvents.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
      const next = append(f.initial, { id: "update-1", text: "Include the test results in the complete answer." }, call.id);
      const nextEvents: AdapterEvent[] = [];
      const nextRound = f.run(next, nextEvents);
      const reply = await until(() => f.broker.taskUpdateState(requestId)?.acceptedRevision === 1 ? true : undefined, "accepted revision 1").then(() => f.wait(requestId));
      expect(reply).toMatchObject({ kind: "result", result: { content: [{ type: "text", text: nativeResult }] },
        taskUpdate: { throughRevision: 1, updates: [{ sourceMessageId: "update-1", content: "Include the test results in the complete answer." }] } });
      expect(f.starts).toHaveLength(1);
      expect(f.started).toEqual([requestId]);
      expect(f.automaticStarts()).toBe(0);
      await expect(f.complete(requestId, 0, "old answer")).rejects.toMatchObject({
        code: "task_update_unacknowledged", taskUpdate: reply.taskUpdate,
      });
      expect(f.broker.taskUpdateState(requestId)).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 0, finalOutputRevision: null });
      expect(await f.ack(requestId, reply.taskUpdate!)).toEqual({ acknowledgedRevision: 1, acceptedRevision: 1 });
      await f.complete(requestId, 1, "Complete answer with test results.");
      await nextRound;
      expect(nextEvents.flatMap(event => event.type === "text_delta" && event.phase === "final_answer" ? [event.text] : []).join(""))
        .toBe("Complete answer with test results.");
      expect(nextEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      expect(f.starts).toHaveLength(1);
      expect(f.cancels).toHaveLength(0);
      expect(f.ends.map(event => event.status)).toEqual(["completed"]);
      const replay: AdapterEvent[] = [];
      await f.run(f.initial, replay);
      expect(replay.filter(event => event.type !== "heartbeat")).toEqual(sourceEvents.filter(event => event.type !== "heartbeat"));
      expect(f.starts).toHaveLength(1);
    } finally { await f.close(); }
  }, 15_000);

  test("continuous append ends the old observer and its stale abort cannot cancel the current manual runtime", async () => {
    const f = await fixture();
    try {
      const sourceEvents: AdapterEvent[] = [];
      const sourceRound = f.run(f.initial, sourceEvents);
      const requestId = await f.ready;
      await f.start(requestId);
      await sourceRound;
      const call = toolCall(sourceEvents);
      const first = append(f.initial, { id: "update-1", text: "Include tests." }, call.id);
      const oldEvents: AdapterEvent[] = [];
      const oldAbort = new AbortController();
      const oldObserver = f.run(first, oldEvents, oldAbort.signal);
      await until(() => f.broker.taskUpdateState(requestId)?.acceptedRevision === 1 ? true : undefined, "first append");
      const firstReply = await f.wait(requestId);
      const second = append(first, { id: "update-2", text: "Also explain the migration." }, call.id);
      const currentEvents: AdapterEvent[] = [];
      const currentObserver = f.run(second, currentEvents);
      await until(() => f.broker.taskUpdateState(requestId)?.acceptedRevision === 2 ? true : undefined, "second append");
      oldAbort.abort();
      await oldObserver;
      expect(oldEvents.filter(event => event.type === "incomplete")).toEqual([
        { type: "incomplete", reason: "task_update_handoff", retryable: false, endTurn: false },
      ]);
      expect(await f.wait(requestId)).toEqual(firstReply);
      const firstAck = await f.ack(requestId, firstReply.taskUpdate!);
      expect(firstAck).toMatchObject({ acknowledgedRevision: 1, acceptedRevision: 2,
        taskUpdate: { throughRevision: 2, updates: [{ sourceMessageId: "update-2", content: "Also explain the migration." }] } });
      await expect(f.complete(requestId, 1, "incomplete revision-1 answer")).rejects.toMatchObject({
        code: "task_update_unacknowledged", taskUpdate: firstAck.taskUpdate,
      });
      expect(f.broker.taskUpdateState(requestId)).toMatchObject({
        acceptedRevision: 2, deliveredRevision: 2, acknowledgedRevision: 1, driverGeneration: 2, finalOutputRevision: null,
      });
      expect(f.starts).toHaveLength(1);
      expect(f.cancels).toHaveLength(0);
      expect(f.ends).toHaveLength(0);
      expect(await f.ack(requestId, firstAck.taskUpdate!)).toEqual({ acknowledgedRevision: 2, acceptedRevision: 2 });
      await f.complete(requestId, 2, "Full answer including tests and migration.");
      await currentObserver;
      expect(currentEvents.flatMap(event => event.type === "text_delta" && event.phase === "final_answer" ? [event.text] : []).join(""))
        .toBe("Full answer including tests and migration.");
      expect(currentEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      expect(f.starts).toHaveLength(1);
      expect(f.cancels).toHaveLength(0);
      expect(f.ends.map(event => event.status)).toEqual(["completed"]);
      const oldReplay: AdapterEvent[] = [];
      await f.run(first, oldReplay);
      expect(oldReplay.filter(event => event.type !== "heartbeat")).toEqual(oldEvents.filter(event => event.type !== "heartbeat"));
    } finally { await f.close(); }
  }, 15_000);

  test("journal exhaustion after ACK preserves the capacity terminal and closes the manual authority", async () => {
    const f = await fixture();
    try {
      const sourceEvents: AdapterEvent[] = [];
      const sourceRound = f.run(f.initial, sourceEvents);
      const requestId = await f.ready;
      expect(await f.start(requestId)).toMatchObject({ kind: "pending", operation_id: 1 });
      await sourceRound;
      expect(sourceEvents.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
      const next = append(f.initial, { id: "capacity-update", text: "Include validation in the complete answer." }, toolCall(sourceEvents).id);
      const observing = deferred<void>();
      const nextToolBatch = f.broker.nextToolBatch.bind(f.broker);
      f.broker.nextToolBatch = (token, signal, context) => {
        if (context?.expectedDriverGeneration === 1) observing.resolve();
        return nextToolBatch(token, signal, context);
      };
      const events: AdapterEvent[] = [];
      const round = f.run(next, events);
      await until(() => f.broker.taskUpdateState(requestId)?.acceptedRevision === 1 ? true : undefined, "capacity append acceptance");
      const reply = await f.wait(requestId);
      expect(reply).toMatchObject({ kind: "result", result: { content: [{ type: "text", text: nativeResult }] },
        taskUpdate: { throughRevision: 1, updates: [{ sourceMessageId: "capacity-update", content: "Include validation in the complete answer." }] } });
      expect(await f.ack(requestId, reply.taskUpdate!)).toEqual({ acknowledgedRevision: 1, acceptedRevision: 1 });
      await observing.promise;
      const session = f.session();
      const roundKey = chatGptTurnRoundKey(next);
      expect(session.hasPendingTaskUpdate()).toBe(false);
      const budget = session as unknown as {
        readonly taskUpdateSourceBytes: number;
        readonly taskUpdateJournalBytes: number;
        readonly taskUpdateErrorRoundReserves: ReadonlySet<string>;
      };
      const remaining = TASK_UPDATE_SESSION_JOURNAL_BYTES - budget.taskUpdateSourceBytes - budget.taskUpdateJournalBytes
        - budget.taskUpdateErrorRoundReserves.size * TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES;
      const padding: AdapterEvent = { type: "text_delta", text: "", phase: "commentary" };
      padding.text = "x".repeat(remaining - Buffer.byteLength(JSON.stringify([padding])));
      session.appendRoundEvents(roundKey, [padding]);
      expect(budget.taskUpdateSourceBytes + budget.taskUpdateJournalBytes
        + budget.taskUpdateErrorRoundReserves.size * TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES).toBe(TASK_UPDATE_SESSION_JOURNAL_BYTES);

      expect(await f.complete(requestId, 1, "Complete answer including validation.")).toMatchObject({ completed: true });
      await round;
      const terminal = events.at(-1);
      expect(terminal).toMatchObject({ type: "error", code: "task_update_capacity", retryable: false });
      if (terminal?.type !== "error") throw new Error("The exhausted manual round lost its capacity error terminal");
      expect(events.some(event => event.type === "done" && event.endTurn)).toBe(false);
      expect(session.roundCompleted(roundKey)).toBe(true);
      expect(session.isTaskUpdateCancelled()).toBe(true);
      expect(budget.taskUpdateSourceBytes + budget.taskUpdateJournalBytes).toBeLessThanOrEqual(TASK_UPDATE_SESSION_JOURNAL_BYTES);
      await session.browserOutcome;
      await session.physicalSettlement;
      await f.broker.waitForRetirement(requestId, AbortSignal.timeout(1_000));
      expect(session.isActive()).toBe(false);
      await expect(f.wait(requestId)).rejects.toMatchObject({ code: "codex_tool_operation_retired" });
      const replay: AdapterEvent[] = [];
      await f.run(next, replay);
      expect(replay.at(-1)).toEqual(terminal);
      expect(replay.filter(event => event.type === "error")).toEqual([terminal]);
      expect(f.starts).toHaveLength(1);
      expect(f.started).toEqual([requestId]);
      expect(f.automaticStarts()).toBe(0);
    } finally { await f.close(); }
  }, 15_000);

  test("an append before initial Sent follows the existing new manual prompt path and never sends automatically", async () => {
    const f = await fixture({ awaitingSent: true });
    try {
      const oldEvents: AdapterEvent[] = [];
      const oldRound = f.run(f.initial, oldEvents);
      await until(() => f.starts[0], "first manual prompt");
      const oldRequestId = f.starts[0]!.requestId;
      const next = append(f.initial, { id: "update-before-sent", text: "Revise the initial request before I send it." });
      const currentEvents: AdapterEvent[] = [];
      const currentRound = f.run(next, currentEvents);
      const current = await until(() => f.starts[1], "replacement manual prompt");
      await oldRound;
      expect(current.requestId).not.toBe(oldRequestId);
      expect(current.prompt).toContain("Revise the initial request before I send it.");
      expect(f.started).toHaveLength(0);
      expect(f.automaticStarts()).toBe(0);
      expect(() => f.broker.startSafeTurn(oldRequestId)).toThrow("invalid, expired, or revoked");
      expect(f.broker.taskUpdateState(current.requestId)).toMatchObject({ acceptedRevision: 0, acknowledgedRevision: 0, driverGeneration: 0 });
      current.sent.resolve();
      expect(await f.ready).toBe(current.requestId);
      await f.complete(current.requestId, 0, "Answer to the revised initial request.");
      await currentRound;
      expect(currentEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      expect(f.starts).toHaveLength(2);
      expect(f.started).toEqual([current.requestId]);
    } finally { await f.close(); }
  }, 15_000);
});
