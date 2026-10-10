import { afterEach, expect, spyOn, test } from "bun:test";
import { $ } from "bun";
import { harmlessContinuityCommand } from "./helpers/continuity-command";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { ContinuityRecoveryStore, continuityProcessInstance, continuityProcessInstanceStatus, type RecoveryCallRecord } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, sameContinuityRecoveryIdentity, type ContinuityLease, type ContinuityRecoveryIdentity } from "../src/adapters/chatgpt-web/continuity-contract";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnExecutionKey, chatGptTurnSessions, TASK_UPDATE_SESSION_JOURNAL_BYTES } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { NativeOperationReply } from "../src/adapters/chatgpt-web/native-tool-operations";
import type { TaskUpdateTransfer, TaskUpdateTransferOutcome, UpdateDelivery } from "../src/adapters/chatgpt-web/task-update-protocol";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { defaultBrokerEndpoint } from "../src/config";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { parseRequest } from "../src/responses/parser";
import { encodeCompactionSummary } from "../src/responses/compaction";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  // A backend exit drops its memory. Calling clear() in the child would instead persist
  // an explicit user stop for the interrupted work and would test a different event.
  if (!process.env.CGW_CONTINUITY_CHILD_SCENARIO) chatGptTurnSessions.clear();
  for (const action of cleanup.splice(0).reverse()) await action();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function user(id: string, content = id): Record<string, unknown> {
  return { type: "message", role: "user", id, content,
    internal_chat_message_metadata_passthrough: { turn_id: "turn", content_item_kinds: ["user.text"] } };
}
const output = (id: string, text = "first result") => ({ type: "function_call_output", call_id: id, output: text });
function callEvidence(calls: Record<string, RecoveryCallRecord>) {
  // Body cache ownership can change after a real backend exit. Issuer, attempt, batch,
  // terminal state and first result digest remain exact durable dispatch evidence.
  return Object.fromEntries(Object.entries(calls).map(([id, call]) => {
    const { resultBodyBytes: _bytes, resultBodyOwner: _owner, ...evidence } = call;
    return [id, evidence];
  }));
}
function resultStorage(session: ReturnType<Awaited<ReturnType<typeof fixture>>["session"]>) {
  // Inspect the retained bodies and the authoritative storage ledger, independently of heap GC.
  return session as unknown as { continuityReceivedResults: Map<string, unknown>;
    continuityReceivedResultBytes: number; taskUpdateStorageBytes(): number };
}

async function fixture(manual = false, protocol = true, search = false,
  options: { root?: string; preserveRoot?: boolean } = {}) {
  // Keep Unix socket paths short; Windows uses its system temp directory and named pipes.
  const root = options.root ?? mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-cont-update-"));
  const pages = new Map<string, { continuity: ContinuityLease; state: "ready" | "running" }>();
  // This virtual Launcher has its own simulated instance when the sandbox cannot read ps.
  // Backend owner/exit evidence always comes from the actual recovery store process identity.
  const launcherStart = continuityProcessInstance().startIdentity;
  const launcherInstance = { pid: process.pid, startIdentity: launcherStart === "unverified"
    ? "darwin:Sat Oct 10 00:00:00 2026" : launcherStart, instanceId: "a".repeat(64) };
  // The browser and Launcher responses are test doubles. Keep their transaction receipts
  // across the backend child process, without turning an unknown receipt into retirement.
  const launcherStatePath = join(root, "fixture-launcher-receipts.json");
  type PageReceipt = { recovery: ContinuityRecoveryIdentity; key: string;
    state: "prepared" | "send-possible" | "completed" | "missing" | "retired"; writerRetired: boolean };
  const receipts = existsSync(launcherStatePath)
    ? JSON.parse(readFileSync(launcherStatePath, "utf8")) as PageReceipt[] : [];
  const saveReceipts = () => writeFileSync(launcherStatePath, JSON.stringify(receipts));
  const coordination: Array<{ action: string; recovery: ContinuityRecoveryIdentity }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("continuity-capacity")) return Response.json({ ok: true, available: true });
    const body = await request.json() as { conversationKey: string; expected: ContinuityLease; recovery?: ContinuityLease["recovery"] };
    if (path.includes("continuity-") && body.recovery) {
      const action = path.slice(path.lastIndexOf("continuity-") + "continuity-".length);
      coordination.push({ action, recovery: structuredClone(body.recovery) });
      const receipt = receipts.find(value => sameContinuityRecoveryIdentity(value.recovery, body.recovery!));
      if (!receipt) return action === "query"
        ? Response.json({ ok: true, recovery: body.recovery, launcherInstance, hostNoWriter: pages.size === 0,
          state: "unknown", writerRetired: false, toolsSettled: false })
        : Response.json({ ok: false, code: "continuity_source_unproven" }, { status: 409 });
      let sendAuthorized: boolean | undefined;
      if (action === "retire") { pages.delete(receipt.key); receipt.state = "retired"; receipt.writerRetired = true; }
      if (action === "send-possible") {
        if (!["prepared", "send-possible"].includes(receipt.state) || !pages.has(receipt.key))
          return Response.json({ ok: false, code: "continuity_session_lost" }, { status: 409 });
        sendAuthorized = receipt.state === "prepared";
        receipt.state = "send-possible";
      }
      saveReceipts();
      return Response.json({ ok: true, recovery: receipt.recovery, state: receipt.state,
        launcherInstance, hostNoWriter: receipt.writerRetired && !pages.has(receipt.key),
        writerRetired: receipt.writerRetired, toolsSettled: false, ...(sendAuthorized === undefined ? {} : { sendAuthorized }) });
    }
    const page = pages.get(body.conversationKey);
    if (new URL(request.url).pathname.endsWith("release")) { pages.delete(body.conversationKey); return Response.json({ ok: true, released: 1 }); }
    return page && JSON.stringify(page.continuity) === JSON.stringify(body.expected)
      ? Response.json({ ok: true, ...page }) : Response.json({ ok: false, code: "continuity_session_lost" }, { status: 409 });
  } });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development",
    pid: process.pid, launcherInstance, features: [CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE], endpoint: `http://127.0.0.1:${server.port}`,
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
  const browserRuns: Array<{ turn: BrowserTurn; key: string; prompt: string; answer: ReturnType<typeof deferred<string>> }> = [];
  const submissionWaiters = new Map<number, ReturnType<typeof deferred<void>>>();
  const waitSubmission = async (count: number) => {
    if (browserRuns.length >= count) return;
    let waiter = submissionWaiters.get(count);
    if (!waiter) { waiter = deferred<void>(); submissionWaiters.set(count, waiter); }
    await waiter.promise;
  };
  const acquire = (key: string, continuity: ContinuityLease, state: PageReceipt["state"]) => {
    pages.set(key, { continuity, state: "running" });
    if (continuity.recovery) {
      receipts.push({ recovery: structuredClone(continuity.recovery), key, state, writerRetired: false });
      saveReceipts();
    }
  };
  let submissions = 0;
  let sendActivations = 0;
  let physicalKey = "";
  let token = "";
  const runWorker = spyOn(worker, "run").mockImplementation(async turn => {
    submissions++;
    physicalKey = turn.conversationKey!;
    const lease = { owner: turn.continuity!.owner, leaseId: "1".repeat(32), traceId: turn.traceId, recovery: turn.continuity!.recovery };
    const key = physicalKey;
    acquire(key, lease, "prepared");
    turn.onContinuityLease!(lease);
    const compiled = await turn.prepare();
    if (turn.nativeConnector) {
      const control = compiled.text.match(/turn_token (control_[a-f0-9]{32})/)![1]!;
      const handoffId = compiled.text.match(/handoff_id (handoff_[a-f0-9]{32})/)![1]!;
      const aborted = new Promise<void>(resolve => turn.abortSignal!.addEventListener("abort", () => resolve(), { once: true }));
      await turn.onSendActivated?.();
      sendActivations++;
      await turn.onSubmitted?.();
      await callTurnBroker(socket, { method: "submit_compaction_handoff", token: control, handoffId, summary: "Current appended work checkpoint." });
      await aborted;
      pages.get(key)!.state = "ready";
      const receipt = receipts.find(value => sameContinuityRecoveryIdentity(value.recovery, lease.recovery!));
      if (receipt) { receipt.state = "completed"; receipt.writerRetired = true; saveReceipts(); }
      return "";
    }
    token = compiled.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)![1]!;
    await turn.onSendActivated?.();
    sendActivations++;
    await turn.onSubmitted?.();
    const browserRun = { turn, key, prompt: compiled.text, answer: deferred<string>() };
    browserRuns.push(browserRun);
    submissionWaiters.get(browserRuns.length)?.resolve();
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
      browserRun.answer.promise.then(value => {
        const page = pages.get(key); if (page) page.state = "ready";
        const receipt = receipts.find(value => sameContinuityRecoveryIdentity(value.recovery, lease.recovery!));
        if (receipt) { receipt.state = "completed"; saveReceipts(); }
        resolve(value);
      }, reject);
    });
  });
  const manualControl: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      submissions++;
      physicalKey = activity.conversationKey!;
      const continuity = { owner: activity.continuity!.owner, leaseId: "1".repeat(32), traceId: activity.traceId, recovery: activity.continuity!.recovery };
      acquire(physicalKey, continuity, "send-possible");
      token = JSON.parse(activity.prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)\n/)![1]!).request_id;
      return { continuity };
    },
    async waitSent() { broker.startSafeTurn(token); sendActivations++; },
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
  const start = (operationId: number, taskRevision = 0, command = "simulated only") => callTurnBroker<NativeOperationReply & { taskUpdate?: UpdateDelivery }>(socket, {
    method: "native_operation_start", token, contract, nativeWaitProtocol: 1, ...(protocol ? { taskUpdateProtocol: 1, taskRevision } : {}),
    operationId, entry: "codex_exec", nativeInput: { cmd: command }, waitMs: 1,
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
      const { turn } = browserRuns.at(-1)!;
      const context = state ? { expectedDriverGeneration: state.driverGeneration,
        taskRevision: state.acceptedRevision, acknowledgedRevision: state.acknowledgedRevision } : undefined;
      turn!.onTextDelta("Completed with the appended instruction.", context);
      const fence = await turn!.completionFence!.begin(context);
      if (fence !== undefined) expect(await turn!.completionFence!.commit(fence, context)).toBeTrue();
      browserRuns.at(-1)!.answer.resolve("Completed with the appended instruction.");
    }
  };
  cleanup.push(async () => {
    broker.acceptTaskUpdate = originalAccept;
    compatible.mockRestore(); supported.mockRestore(); runWorker.mockRestore();
    await broker.close(); await server.stop(true);
    if (!options.preserveRoot) rmSync(root, { recursive: true, force: true });
  });
  return { initial, request, run, ready: ready.promise, start, wait, ack, finish, session, broker,
    pages, provider, adapter, startTool, socket, root, statePath, browserRuns, coordination, waitSubmission,
    losePage: () => {
      const current = browserRuns.at(-1)!;
      pages.delete(current.key);
      const receipt = receipts.find(value => sameContinuityRecoveryIdentity(value.recovery, current.turn.continuity!.recovery!));
      if (receipt) { receipt.state = "missing"; receipt.writerRetired = true; saveReceipts(); }
      current.answer.reject(continuityError("continuity_session_lost"));
    },
    record: () => new ContinuityRecoveryStore(statePath).get(continuityDigest(root))!,
    dropPages: () => {
      pages.clear();
      for (const receipt of receipts) { receipt.state = "missing"; receipt.writerRetired = true; }
      saveReceipts();
    },
    submissions: () => submissions, sends: () => sendActivations, token: () => token };
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

function blockTaskOutputPublication(f: Awaited<ReturnType<typeof fixture>>, stage: "write" | "rename") {
  const directory = f.broker.taskUpdateState(f.token())!.acknowledgementDirectory!;
  const path = join(directory, stage === "write" ? "version.next" : "version.json");
  const oldVersion = readFileSync(join(directory, "version.json"), "utf8");
  if (stage === "rename") rmSync(path);
  mkdirSync(path);
  return () => {
    rmSync(path, { recursive: true, force: true });
    if (stage === "rename") writeFileSync(path, oldVersion);
  };
}

for (const scenario of [{ stage: "write" }, { stage: "rename" }, { stage: "write", loseReceipt: true }] as const)
test(`recovery E3: failed helper version ${scenario.stage}${"loseReceipt" in scenario ? " with a lost committed receipt" : ""} keeps B committed and reconciles the same transfer`, async () => {
  const stage = scenario.stage;
  const f = await fixture();
  const [call] = await batch(f);
  const before = f.record();
  const session = f.session();
  const firstResult = output(call!.id, "Real external first return.");
  const input = [user("initial-user", "Inspect the project."), firstResult, user("append", "Also inspect tests.")];
  const accepted: Array<{ transfer: TaskUpdateTransfer; outcome: TaskUpdateTransferOutcome }> = [];
  let receiptLost = false;
  const accept = f.broker.acceptTaskUpdate.bind(f.broker);
  const traced = spyOn(f.broker, "acceptTaskUpdate").mockImplementation((token, transfer) => {
    const outcome = accept(token, transfer);
    accepted.push({ transfer: structuredClone(transfer), outcome });
    if ("loseReceipt" in scenario && !receiptLost && outcome.status === "committed") {
      receiptLost = true;
      throw new Error("The committed transfer receipt was lost after durable acceptance");
    }
    return outcome;
  });
  cleanup.push(async () => { traced.mockRestore(); });
  const unblock = blockTaskOutputPublication(f, stage);
  try {
    await expect(f.run(f.request(input))).rejects.toMatchObject({ code: "task_update_transfer_pending" });
    expect(receiptLost).toBe("loseReceipt" in scenario);
    expect(accepted.every(value => value.outcome.status === "committed" && value.outcome.synchronizationPending)).toBeTrue();
    const committed = f.record();
    const headId = committed.currentWorkId!;
    expect(headId).not.toBe(before.currentWorkId);
    expect(committed.works[headId]).toMatchObject({ instructionIdentity: "append", state: "active",
      predecessorLogicalWorkId: before.currentWorkId, workLineageId: before.works[before.currentWorkId!]!.workLineageId });
    expect(committed.works[headId]!.attempts).toHaveLength(1);
    expect(committed.works[before.currentWorkId!]!.attempts[0]!.writerRetired).toBeTrue();
    expect(committed.calls[call!.id]).toMatchObject({ logicalWorkId: before.currentWorkId, attempt: 0,
      state: "settled", firstResultDigest: recoveryResultDigest(firstResult) });
    expect(f.broker.taskUpdateState(f.token())).toMatchObject({ acceptedRevision: 1, driverGeneration: 1,
      deliveredRevision: 0, acknowledgedRevision: 0 });
    expect(session.hasPendingTaskUpdate()).toBeTrue();
    expect(session.driverGeneration()).toBe(0);
    expect(await f.wait(1)).toMatchObject({ kind: "pending" });
    await expect(f.broker.nextToolBatch(f.token(), undefined, { expectedDriverGeneration: 1, taskRevision: 1 })).rejects
      .toMatchObject({ code: "task_update_transfer_pending" });
    expect(() => f.broker.beginFinalOutput(f.token(), { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 }))
      .toThrow("stale");
    expect(f.submissions()).toBe(1);
  } finally { unblock(); }
  const transfer = accepted[0]!.transfer;
  const committedId = f.record().currentWorkId!;
  const events: AdapterEvent[] = [];
  const running = f.run(f.request(input, "retry-original-transfer"), events);
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  expect(reply.kind === "result" && reply.result.content).toEqual([{ type: "text", text: firstResult.output }]);
  expect(reply.taskUpdate?.updates.map(update => update.sourceMessageId)).toEqual(["append"]);
  f.ack(reply.taskUpdate!);
  expect(f.record().currentWorkId).toBe(committedId);
  expect(f.record().works[committedId]!.attempts).toHaveLength(1);
  expect(session.hasPendingTaskUpdate()).toBeFalse();
  expect(session.driverGeneration()).toBe(1);
  expect(f.broker.taskUpdateTransferOutcome(f.token(), transfer.transferId)).toMatchObject({ status: "committed" });
  expect(f.broker.taskUpdateTransferOutcome(f.token(), transfer.transferId)).not.toHaveProperty("synchronizationPending");
  expect(accepted.every(value => value.transfer.transferId === transfer.transferId
    && value.transfer.payloadDigest === transfer.payloadDigest && value.transfer.batchFingerprint === transfer.batchFingerprint)).toBeTrue();
  expect(await f.wait(1)).toMatchObject({ kind: "result", result: { content: [{ type: "text", text: firstResult.output }] } });
  await f.finish();
  expect((await running).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(events.some(event => event.type === "tool_call_start")).toBeFalse();
  expect(f.submissions()).toBe(1);
  expect(f.sends()).toBe(1);
  expect(Object.keys(f.record().calls)).toEqual([call!.id]);
});

test("recovery E3: a failure before durable append preserves A and its outstanding call", async () => {
  const f = await fixture();
  const [call] = await batch(f);
  const before = f.record();
  const session = f.session();
  const transact = ContinuityRecoveryStore.prototype.transact;
  let insideAcceptance = false;
  const failure = spyOn(ContinuityRecoveryStore.prototype, "transact").mockImplementation(function (this: ContinuityRecoveryStore, thread, guard, mutate) {
    return transact.call(this, thread, guard, draft => {
      mutate(draft);
      if (insideAcceptance && this.directory === f.statePath) throw continuityError("continuity_configuration_conflict");
    });
  });
  const accept = f.broker.acceptTaskUpdate.bind(f.broker);
  let outcome: TaskUpdateTransferOutcome | undefined;
  const boundary = spyOn(f.broker, "acceptTaskUpdate").mockImplementation((token, transfer) => {
    insideAcceptance = true;
    try { outcome = accept(token, transfer); return outcome; }
    finally { insideAcceptance = false; }
  });
  try {
    await expect(f.run(f.request([output(call!.id), user("rejected-B", "Uncommitted update.")]))).rejects
      .toMatchObject({ code: "task_update_invalid" });
    expect(outcome).toMatchObject({ status: "not_committed" });
    expect(f.record()).toEqual(before);
    expect(session.driverGeneration()).toBe(0);
    expect(session.taskRevision()).toBe(0);
    expect(session.hasPendingTaskUpdate()).toBeFalse();
    expect(session.hasOutstanding(call!.id)).toBeTrue();
    expect(f.broker.taskUpdateState(f.token())).toMatchObject({ acceptedRevision: 0, driverGeneration: 0 });
    expect(await f.wait(1)).toMatchObject({ kind: "pending" });
    expect(f.submissions()).toBe(1);
  } finally { boundary.mockRestore(); failure.mockRestore(); }
  const running = f.run(f.request([output(call!.id), user("new-B", "A new valid update.")]));
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  f.ack(reply.taskUpdate!);
  await f.finish();
  expect((await running).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions()).toBe(1);
});

for (const blockReadback of [false, true]) test(`recovery E3: atomic B replacement${blockReadback ? " with unavailable readback" : ""} remains fenced until durable confirmation`, async () => {
  const f = await fixture();
  const [call] = await batch(f);
  const before = f.record();
  const firstResult = output(call!.id);
  const input = [user("initial-user", "Inspect the project."), firstResult, user("append", "Confirm accepted B.")];
  const transact = ContinuityRecoveryStore.prototype.transact;
  const get = ContinuityRecoveryStore.prototype.get;
  const confirm = ContinuityRecoveryStore.prototype.confirmDurable;
  let insideAcceptance = false;
  let replaced = false;
  let blocked = true;
  const transaction = spyOn(ContinuityRecoveryStore.prototype, "transact").mockImplementation(function (this: ContinuityRecoveryStore, thread, guard, mutate) {
    if (insideAcceptance && this.directory === f.statePath && !replaced) {
      const faulting = new ContinuityRecoveryStore(this.directory, { afterAtomicReplace() {
        replaced = true; throw new Error("Directory durability confirmation unavailable after actual atomic replacement");
      } });
      return transact.call(faulting, thread, guard, mutate);
    }
    return transact.call(this, thread, guard, mutate);
  });
  const reading = spyOn(ContinuityRecoveryStore.prototype, "get").mockImplementation(function (this: ContinuityRecoveryStore, thread) {
    if (this.directory === f.statePath && replaced && blocked && blockReadback)
      throw continuityError("continuity_configuration_conflict", "Readback temporarily unavailable");
    return get.call(this, thread);
  });
  const confirming = spyOn(ContinuityRecoveryStore.prototype, "confirmDurable").mockImplementation(function (this: ContinuityRecoveryStore, thread, guard) {
    if (this.directory === f.statePath && blocked) throw continuityError("continuity_configuration_conflict", "Durability confirmation temporarily unavailable");
    return confirm.call(this, thread, guard);
  });
  const transfers: TaskUpdateTransfer[] = [];
  const accept = f.broker.acceptTaskUpdate.bind(f.broker);
  const accepting = spyOn(f.broker, "acceptTaskUpdate").mockImplementation((token, transfer) => {
    insideAcceptance = true; transfers.push(structuredClone(transfer));
    try { return accept(token, transfer); } finally { insideAcceptance = false; }
  });
  cleanup.push(async () => { accepting.mockRestore(); confirming.mockRestore(); reading.mockRestore(); transaction.mockRestore(); });
  await expect(f.run(f.request(input))).rejects.toMatchObject({ code: blockReadback ? "task_update_transfer_unknown" : "task_update_transfer_pending" });
  expect(replaced).toBeTrue();
  const durable = get.call(new ContinuityRecoveryStore(f.statePath), continuityDigest(f.root))!;
  const headId = durable.currentWorkId!;
  expect(headId).not.toBe(before.currentWorkId);
  expect(durable.works[headId]).toMatchObject({ instructionIdentity: "append", predecessorLogicalWorkId: before.currentWorkId });
  expect(durable.works[before.currentWorkId!]!.attempts[0]!.writerRetired).toBeTrue();
  expect(durable.calls[call!.id]).toMatchObject({ state: "settled", firstResultDigest: recoveryResultDigest(firstResult) });
  const transferId = transfers[0]!.transferId;
  expect(f.broker.taskUpdateTransferOutcome(f.token(), transferId).status).toBe(blockReadback ? "unknown" : "committed");
  const malformedRetry = structuredClone(transfers[0]!);
  (malformedRetry as unknown as { invalid: unknown }).invalid = malformedRetry;
  expect(() => accept(f.token(), malformedRetry)).toThrow("payload changed");
  expect(f.broker.taskUpdateTransferOutcome(f.token(), transferId).status).toBe(blockReadback ? "unknown" : "committed");
  expect(f.session().hasPendingTaskUpdate()).toBeTrue();
  expect(f.session().driverGeneration()).toBe(0);
  expect(await f.wait(1)).toMatchObject({ kind: "pending" });
  await expect(f.broker.nextToolBatch(f.token(), undefined, { expectedDriverGeneration: blockReadback ? 0 : 1,
    taskRevision: blockReadback ? 0 : 1 })).rejects.toMatchObject({ code: "task_update_transfer_pending" });
  const blockedDecision = await f.start(2, blockReadback ? 0 : 1);
  expect(blockedDecision).toMatchObject({ kind: "result", result: { isError: true } });
  expect(blockedDecision.kind === "result" && blockedDecision.result.content[0]).toMatchObject({ type: "text",
    text: expect.stringContaining('"reason":"transfer_pending"') });
  blocked = false;
  const events: AdapterEvent[] = [];
  const running = f.run(f.request(input, "same-atomic-transfer"), events);
  void running.catch(() => {});
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  f.ack(reply.taskUpdate!);
  expect(f.record().currentWorkId).toBe(headId);
  expect(f.record().works[headId]!.attempts).toHaveLength(1);
  expect(transfers.every(transfer => transfer.transferId === transferId
    && transfer.payloadDigest === transfers[0]!.payloadDigest && transfer.batchFingerprint === transfers[0]!.batchFingerprint)).toBeTrue();
  expect(f.broker.taskUpdateTransferOutcome(f.token(), transferId)).toMatchObject({ status: "committed" });
  expect(f.broker.taskUpdateTransferOutcome(f.token(), transferId)).not.toHaveProperty("synchronizationPending");
  expect(f.session().driverGeneration()).toBe(1);
  await f.finish();
  expect((await running).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(events.some(event => event.type === "tool_call_start")).toBeFalse();
  expect(f.sends()).toBe(1);
  expect(f.submissions()).toBe(1);
  expect(Object.keys(f.record().calls)).toEqual([call!.id]);
});

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

type BackendChainEvidence = {
  sourceLogicalWorkId: string; headLogicalWorkId: string; lineageId: string; callId: string;
  originalInput: unknown[]; appendInput: unknown[]; firstResult?: ReturnType<typeof output>;
  sends: number; dispatches: number; pageKey: string; summary?: string; checkpointId?: string;
  failedTransfer?: Pick<TaskUpdateTransfer, "transferId" | "payloadDigest" | "batchFingerprint">;
  sourceSnapshotDigest?: string; headSnapshotDigest?: string;
};
const backendScenario = process.env.CGW_CONTINUITY_CHILD_SCENARIO;
if (backendScenario) test("recovery fixture: backend source chain", async () => {
  const root = process.env.CGW_CONTINUITY_CHILD_ROOT!;
  const f = await fixture(false, true, false, { root, preserveRoot: true });
  const counter = join(root, "harmless-command-count");
  const command = backendScenario === "recover"
    ? harmlessContinuityCommand(counter, "real predecessor result") : "simulated only";
  const sourceEvents: AdapterEvent[] = [];
  const first = f.run(f.initial, sourceEvents);
  await f.ready;
  expect(await f.start(1, 0, command)).toMatchObject({ kind: "pending" });
  await first;
  const calls = sourceEvents.filter((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  const argumentsText = sourceEvents.filter((event): event is Extract<AdapterEvent, { type: "tool_call_delta" }> => event.type === "tool_call_delta")
    .map(event => event.arguments).join("");
  expect(JSON.parse(argumentsText).cmd).toBe(command);
  const issued = f.record();
  const sourceLogicalWorkId = issued.currentWorkId!;
  expect(issued.calls[call.id]).toMatchObject({ logicalWorkId: sourceLogicalWorkId, attempt: 0,
    expectedResultType: "function_call_output", state: "delivery-possible", batchSequence: 1 });

  // B is accepted while A's real delivered operation still waits for its first return.
  const originalInput = (f.initial._rawBody as { input: unknown[] }).input;
  if (backendScenario === "publication-exit") {
    const firstResult = output(call.id, "external terminal return before backend exit");
    const appendInput = [...originalInput, firstResult, user("append", "Continue with the predecessor result.")];
    const transfers: TaskUpdateTransfer[] = [];
    const accept = f.broker.acceptTaskUpdate.bind(f.broker);
    const traced = spyOn(f.broker, "acceptTaskUpdate").mockImplementation((token, transfer) => {
      transfers.push(structuredClone(transfer)); return accept(token, transfer);
    });
    cleanup.push(async () => { traced.mockRestore(); });
    const unblock = blockTaskOutputPublication(f, "write");
    try {
      await expect(f.run(f.request(appendInput))).rejects.toMatchObject({ code: "task_update_transfer_pending" });
      const committed = f.record();
      const headLogicalWorkId = committed.currentWorkId!;
      const head = committed.works[headLogicalWorkId]!;
      expect(headLogicalWorkId).not.toBe(sourceLogicalWorkId);
      expect(head).toMatchObject({ predecessorLogicalWorkId: sourceLogicalWorkId, state: "active",
        workLineageId: issued.works[sourceLogicalWorkId]!.workLineageId });
      expect(head.attempts).toHaveLength(1);
      expect(head.attempts[0]).toMatchObject({ attempt: 0, epoch: 0, stage: "accepted" });
      expect(committed.works[sourceLogicalWorkId]!.attempts[0]!.snapshotDigest)
        .toBe(issued.works[sourceLogicalWorkId]!.attempts[0]!.snapshotDigest);
      expect(committed.works[sourceLogicalWorkId]!.attempts[0]!.writerRetired).toBeTrue();
      expect(committed.calls[call.id]).toMatchObject({ logicalWorkId: sourceLogicalWorkId, attempt: 0,
        state: "settled", firstResultDigest: recoveryResultDigest(firstResult) });
      expect(f.broker.taskUpdateState(f.token())).toMatchObject({ acceptedRevision: 1, driverGeneration: 1 });
      expect(f.session().hasPendingTaskUpdate()).toBeTrue();
      expect(f.session().driverGeneration()).toBe(0);
      expect(await f.wait(1)).toMatchObject({ kind: "pending" });
      expect(transfers.every(transfer => transfer.transferId === transfers[0]!.transferId
        && transfer.payloadDigest === transfers[0]!.payloadDigest && transfer.batchFingerprint === transfers[0]!.batchFingerprint)).toBeTrue();
      f.losePage();
      await f.session().physicalSettlement;
      expect(f.broker.taskUpdateTransferOutcome(f.token(), transfers[0]!.transferId))
        .toMatchObject({ status: "committed", synchronizationPending: true });
      expect(f.record().currentWorkId).toBe(headLogicalWorkId);
      expect(f.submissions()).toBe(1);
      writeFileSync(join(root, "backend-chain-evidence.json"), JSON.stringify({ sourceLogicalWorkId,
        headLogicalWorkId, lineageId: head.workLineageId, callId: call.id, originalInput, appendInput, firstResult,
        sends: f.sends(), dispatches: calls.length, pageKey: f.browserRuns[0]!.key,
        failedTransfer: { transferId: transfers[0]!.transferId, payloadDigest: transfers[0]!.payloadDigest,
          batchFingerprint: transfers[0]!.batchFingerprint },
        sourceSnapshotDigest: issued.works[sourceLogicalWorkId]!.attempts[0]!.snapshotDigest,
        headSnapshotDigest: head.attempts[0]!.snapshotDigest } satisfies BackendChainEvidence));
    } finally { unblock(); }
    return;
  }
  const appendInput = [...originalInput, user("append", "Continue with the predecessor result.")];
  await f.run(f.request(appendInput));
  const delivery = await f.wait(1);
  expect(delivery.kind).toBe("pending");
  expect(delivery.taskUpdate?.updates.map(update => update.sourceMessageId)).toEqual(["append"]);
  f.ack(delivery.taskUpdate!);
  const appended = f.record();
  const headLogicalWorkId = appended.currentWorkId!;
  const head = appended.works[headLogicalWorkId]!;
  const lineageId = head.workLineageId;
  expect(headLogicalWorkId).not.toBe(sourceLogicalWorkId);
  expect(head).toMatchObject({ predecessorLogicalWorkId: sourceLogicalWorkId,
    acceptedTaskRevision: issued.works[sourceLogicalWorkId]!.acceptedTaskRevision + 1,
    workLineageId: appended.works[sourceLogicalWorkId]!.workLineageId, state: "active" });
  expect(head.attempts).toHaveLength(1);
  expect(head.attempts[0]).toMatchObject({ attempt: 0, epoch: 0, stage: "accepted", writerRetired: false });
  expect(appended.works[sourceLogicalWorkId]!.attempts[0]!.writerRetired).toBeTrue();
  expect(appended.calls[call.id]).toEqual(issued.calls[call.id]);
  expect(appended.lineages[lineageId]).toMatchObject({ rootLogicalWorkId: sourceLogicalWorkId,
    headLogicalWorkId, acceptedTaskRevision: issued.lineages[lineageId]!.acceptedTaskRevision + 1, toolBatchHeadSequence: 1 });

  let firstResult: ReturnType<typeof output> | undefined;
  if (backendScenario === "recover") {
    // Execute only the command that the adapter actually dispatched. No browser text echo
    // is accepted as evidence that the outer command ran.
    const processResult = await $`${{ raw: JSON.parse(argumentsText).cmd }}`.quiet().nothrow();
    const stdout = processResult.stdout.toString();
    expect(processResult.exitCode, processResult.stderr.toString()).toBe(0);
    expect(readFileSync(counter, "utf8")).toBe("x");
    firstResult = output(call.id, stdout);
    const running = f.run(f.request([...appendInput, firstResult]));
    let result = await f.wait(1);
    while (result.kind !== "result") result = await f.wait(1);
    expect(result.kind === "result" && result.result.content).toEqual([{ type: "text", text: stdout }]);
    expect(f.record().calls[call.id]).toMatchObject({ state: "settled", firstResultDigest: recoveryResultDigest(firstResult) });
    f.losePage();
    expect((await running).at(-1)).toMatchObject({ type: "error", code: "continuity_session_lost" });
    await f.session().physicalSettlement;
  } else {
    // The external call is settled without executing the placeholder command.
    firstResult = output(call.id, "external terminal return");
    const disconnected = new AbortController();
    const running = f.run(f.request([...appendInput, firstResult]), [], disconnected.signal);
    void running.catch(() => {});
    let result = await f.wait(1);
    while (result.kind !== "result") result = await f.wait(1);
    disconnected.abort(); await running.catch(() => {});
    if (backendScenario === "checkpoint") {
      const compact = f.request([...appendInput, firstResult]);
      compact._compactionRequest = true;
      // The test browser consumes the real Broker compaction interception, then ends
      // the active response. The intercepted proposal must never reach the outer executor.
      const requested = deferred<void>();
      const requestCompaction = f.broker.requestCompaction.bind(f.broker);
      const control = spyOn(f.broker, "requestCompaction").mockImplementation((...args) => {
        const revision = requestCompaction(...args); requested.resolve(); return revision;
      });
      const compacting = f.run(compact);
      void compacting.catch(() => {});
      await requested.promise;
      expect(await f.start(2, 1)).toMatchObject({ kind: "result", result: { isError: true } });
      expect(Object.keys(f.record().calls)).toEqual([call.id]);
      await f.finish();
      const events = await compacting;
      control.mockRestore();
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      const delta = events.find(event => event.type === "text_delta");
      if (delta?.type !== "text_delta") throw new Error("Missing accepted checkpoint summary");
      const checkpoint = Object.values(f.record().checkpoints)[0]!;
      expect(checkpoint).toMatchObject({ sourceLogicalWorkId: headLogicalWorkId, workLineageId: lineageId,
        coveredCallIds: [call.id], sourceToolBatchHeadSequence: 1, targetHistoryRevision: 1 });
      expect(checkpoint.ordinaryFinalReceiptId).toBeUndefined();
      expect(checkpoint.continuation.state).toBe("available");
      expect(f.submissions()).toBe(2);
      f.dropPages();
      writeFileSync(join(root, "backend-chain-evidence.json"), JSON.stringify({ sourceLogicalWorkId,
        headLogicalWorkId, lineageId, callId: call.id, originalInput, appendInput, firstResult,
        summary: delta.text, checkpointId: checkpoint.commitId, sends: f.sends(), dispatches: calls.length,
        pageKey: f.browserRuns[0]!.key } satisfies BackendChainEvidence));
      return;
    } else {
      const physical = f.session();
      const stopped = chatGptTurnSessions.cancelNativeTurn(physical.nativeThreadId!, "turn",
        Object.assign(new Error("Explicit user stop"), { code: "client_cancelled" }));
      expect(stopped.cancelled).toBe(1);
      await stopped.settlement;
      const record = f.record();
      expect(record.state).toBe("stopped");
      for (const id of [sourceLogicalWorkId, headLogicalWorkId]) {
        expect(record.works[id]).toMatchObject({ state: "stopped", stopReason: "user-stop", workLineageId: lineageId });
      }
    }
  }
  expect(f.submissions()).toBe(1);
  writeFileSync(join(root, "backend-chain-evidence.json"), JSON.stringify({ sourceLogicalWorkId,
    headLogicalWorkId, lineageId, callId: call.id, originalInput, appendInput, firstResult,
    sends: f.sends(), dispatches: calls.length, pageKey: f.browserRuns[0]!.key } satisfies BackendChainEvidence));
}, 15_000);

async function exitedBackendChain(scenario: "recover" | "stop" | "checkpoint" | "publication-exit") {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-cont-chain-"));
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const child = Bun.spawn([process.execPath, "test", "--timeout", "15000", import.meta.path,
    "--test-name-pattern", "^recovery fixture: backend source chain$"], {
    env: { ...process.env, CGW_CONTINUITY_CHILD_SCENARIO: scenario, CGW_CONTINUITY_CHILD_ROOT: root },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  const evidence = JSON.parse(readFileSync(join(root, "backend-chain-evidence.json"), "utf8")) as BackendChainEvidence;
  const f = await fixture(false, true, false, { root });
  expect(f.record().owner.pid).toBe(child.pid);
  const ownerStatus = continuityProcessInstanceStatus(f.record().owner);
  if (f.record().owner.startIdentity === "unverified") expect(ownerStatus).toBe("unverified");
  else expect(ownerStatus).toBe("exited");
  expect(f.submissions()).toBe(0);
  expect(f.sends()).toBe(0);
  return { f, evidence, ownerStatus };
}

test("recovery v3: B retains A's real first result and source chain after the backend exits", async () => {
  const { f, evidence: e, ownerStatus } = await exitedBackendChain("recover");
  const before = f.record();
  expect(before.calls[e.callId]).toMatchObject({ logicalWorkId: e.sourceLogicalWorkId,
    workLineageId: e.lineageId, attempt: 0, state: "settled", firstResultDigest: recoveryResultDigest(e.firstResult!) });
  expect(before.currentWorkId).toBe(e.headLogicalWorkId);
  expect(before.works[e.headLogicalWorkId]!.predecessorLogicalWorkId).toBe(e.sourceLogicalWorkId);

  await expect(f.run(f.request(e.appendInput))).rejects.toMatchObject({ code: "continuity_context_missing", retryable: false });
  await expect(f.run(f.request([...e.appendInput, output(e.callId, "changed first result")]))).rejects
    .toMatchObject({ code: "continuity_result_conflict", retryable: false });
  expect(f.record().works).toEqual(before.works);
  expect(f.record().calls).toEqual(before.calls);
  expect(f.submissions()).toBe(0);
  expect(f.pages.size).toBe(0);

  if (ownerStatus === "unverified") {
    await expect(f.run(f.request([...e.appendInput, e.firstResult!]))).rejects.toMatchObject({ code: "continuity_execution_unsettled" });
    expect(f.submissions()).toBe(0);
    expect(f.record().calls).toEqual(before.calls);
    expect(readFileSync(join(f.root, "harmless-command-count"), "utf8")).toBe("x");
    return;
  }

  const recoveredEvents: AdapterEvent[] = [];
  const recovered = f.run(f.request([...e.appendInput, e.firstResult!]), recoveredEvents);
  await f.waitSubmission(1);
  const active = f.record();
  const head = active.works[e.headLogicalWorkId]!;
  expect(active.currentWorkId).toBe(e.headLogicalWorkId);
  expect(active.epoch).toBe(before.epoch + 1);
  expect(head.workLineageId).toBe(e.lineageId);
  expect(head.attempts).toHaveLength(2);
  expect(head.attempts[0]).toMatchObject({ attempt: 0, epoch: 0, stage: "interrupted-settled", writerRetired: true });
  expect(head.attempts[1]).toMatchObject({ attempt: 1, epoch: 1, stage: "accepted", writerRetired: false, snapshotVersion: 1 });
  expect(active.lineages[e.lineageId]).toEqual(before.lineages[e.lineageId]);
  expect(callEvidence(active.calls)).toEqual(callEvidence(before.calls));
  expect(active.calls[e.callId]).toMatchObject({ resultBodyBytes: Buffer.byteLength(JSON.stringify(e.firstResult)),
    resultBodyOwner: { pid: process.pid, startIdentity: active.owner.startIdentity } });
  expect(continuityProcessInstanceStatus(active.calls[e.callId]!.resultBodyOwner!)).toBe("live");
  expect(f.browserRuns[0]!.key).not.toBe(e.pageKey);
  expect(f.browserRuns[0]!.turn.continuity!.recovery).toMatchObject({ logicalWorkId: e.headLogicalWorkId, attempt: 1, epoch: 1 });
  expect(f.browserRuns[0]!.prompt).toContain(e.firstResult!.output);
  expect(f.coordination.some(value => value.action === "retire" && value.recovery.epoch === 0)).toBeTrue();
  expect(f.coordination.filter(value => value.action === "send-possible")).toHaveLength(1);
  await f.finish();
  expect((await recovered).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(recoveredEvents.filter(event => event.type === "tool_call_start")).toHaveLength(0);
  expect(Object.keys(f.record().calls)).toEqual([e.callId]);
  expect(e.sends + f.sends()).toBe(2);
  expect(e.dispatches).toBe(1);
  expect(readFileSync(join(f.root, "harmless-command-count"), "utf8")).toBe("x");
}, 30_000);

test("recovery E3: backend exit after durable B acceptance recovers B without replaying A's settled call", async () => {
  const { f, evidence: e, ownerStatus } = await exitedBackendChain("publication-exit");
  const before = f.record();
  expect(e.failedTransfer).toMatchObject({ transferId: expect.any(String), payloadDigest: expect.any(String),
    batchFingerprint: expect.any(String) });
  expect(before.currentWorkId).toBe(e.headLogicalWorkId);
  const source = before.works[e.sourceLogicalWorkId]!;
  const head = before.works[e.headLogicalWorkId]!;
  expect(source.attempts).toHaveLength(1);
  expect(source.attempts[0]).toMatchObject({ snapshotDigest: e.sourceSnapshotDigest, writerRetired: true });
  expect(head).toMatchObject({ predecessorLogicalWorkId: source.logicalWorkId, workLineageId: e.lineageId,
    instructionIdentity: "append", acceptedTaskRevision: source.acceptedTaskRevision + 1 });
  expect(head.attempts).toHaveLength(1);
  expect(head.attempts[0]).toMatchObject({ snapshotDigest: e.headSnapshotDigest, attempt: 0, epoch: 0 });
  expect(before.calls[e.callId]).toMatchObject({ logicalWorkId: e.sourceLogicalWorkId, attempt: 0,
    state: "settled", firstResultDigest: recoveryResultDigest(e.firstResult!) });
  if (ownerStatus === "unverified") {
    await expect(f.run(f.request(e.appendInput))).rejects.toMatchObject({ code: "continuity_execution_unsettled" });
    expect(f.submissions()).toBe(0);
    expect(f.sends()).toBe(0);
    expect(f.pages.size).toBe(0);
    expect(f.browserRuns).toHaveLength(0);
    const { version: beforeVersion, calls: beforeCalls, ...beforeAuthority } = before;
    const { version: afterVersion, calls: afterCalls, ...afterAuthority } = f.record();
    // A matching accepted result can charge optional cached body bytes during preflight.
    // That accounting must not grant a writer or change any source/attempt/stop evidence.
    expect(afterAuthority).toEqual(beforeAuthority);
    expect(callEvidence(afterCalls)).toEqual(callEvidence(beforeCalls));
    expect(afterVersion).toBeGreaterThanOrEqual(beforeVersion);
    expect(afterCalls[e.callId]).toMatchObject({ resultBodyBytes: Buffer.byteLength(JSON.stringify(e.firstResult)),
      resultBodyOwner: { pid: process.pid, startIdentity: "unverified" } });
    expect(continuityProcessInstanceStatus(afterCalls[e.callId]!.resultBodyOwner!)).toBe("unverified");
    return;
  }
  const events: AdapterEvent[] = [];
  const recovered = f.run(f.request(e.appendInput), events);
  await f.waitSubmission(1);
  const active = f.record();
  expect(active.currentWorkId).toBe(e.headLogicalWorkId);
  expect(active.epoch).toBe(before.epoch + 1);
  expect(active.works[e.headLogicalWorkId]!.attempts).toHaveLength(2);
  expect(active.works[e.headLogicalWorkId]!.attempts[0]).toMatchObject({ snapshotDigest: e.headSnapshotDigest,
    attempt: 0, epoch: 0, writerRetired: true });
  expect(active.works[e.headLogicalWorkId]!.attempts[1]).toMatchObject({ attempt: 1, epoch: 1,
    snapshotVersion: head.attempts[0]!.snapshotVersion + 1, stage: "accepted" });
  expect(active.works[e.sourceLogicalWorkId]).toEqual(source);
  expect(active.lineages[e.lineageId]).toEqual(before.lineages[e.lineageId]);
  expect(callEvidence(active.calls)).toEqual(callEvidence(before.calls));
  expect(active.calls[e.callId]).toMatchObject({ resultBodyBytes: Buffer.byteLength(JSON.stringify(e.firstResult)),
    resultBodyOwner: { pid: process.pid, startIdentity: active.owner.startIdentity } });
  expect(continuityProcessInstanceStatus(active.calls[e.callId]!.resultBodyOwner!)).toBe("live");
  expect(f.browserRuns[0]!.key).not.toBe(e.pageKey);
  expect(f.browserRuns[0]!.prompt).toContain(e.firstResult!.output);
  expect(f.coordination.some(item => item.action === "retire" && item.recovery.epoch === 0)).toBeTrue();
  await f.finish();
  expect((await recovered).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(events.some(event => event.type === "tool_call_start")).toBeFalse();
  expect(Object.keys(f.record().calls)).toEqual([e.callId]);
  expect(e.sends + f.sends()).toBe(2);
  expect(e.dispatches).toBe(1);
}, 30_000);

test("recovery v3: B's committed checkpoint covers A's result body for restart continuation", async () => {
  const { f, evidence: e } = await exitedBackendChain("checkpoint");
  const before = f.record();
  const checkpoint = before.checkpoints[e.checkpointId!]!;
  expect(checkpoint).toMatchObject({ sourceLogicalWorkId: e.headLogicalWorkId, workLineageId: e.lineageId,
    coveredCallIds: [e.callId], targetHistoryRevision: 1 });
  expect(before.calls[e.callId]).toMatchObject({ logicalWorkId: e.sourceLogicalWorkId, workLineageId: e.lineageId,
    state: "settled", firstResultDigest: recoveryResultDigest(e.firstResult!) });
  const input = [{ type: "compaction", encrypted_content: encodeCompactionSummary(e.summary!) }];
  const events: AdapterEvent[] = [];
  const recovered = f.run(f.request(input), events);
  await f.waitSubmission(1);
  const active = f.record();
  const consumer = active.works[active.currentWorkId!]!;
  expect(consumer.logicalWorkId).not.toBe(e.headLogicalWorkId);
  expect(consumer.workLineageId).toBe(e.lineageId);
  expect(active.checkpoints[e.checkpointId!]!.continuation).toMatchObject({ state: "consumed",
    consumerLogicalWorkId: consumer.logicalWorkId });
  expect(active.historyRevision).toBe(1);
  expect(consumer.attempts[0]).toMatchObject({ attempt: 0, epoch: before.epoch + 1, historyRevision: 1, stage: "accepted" });
  expect(callEvidence(active.calls)).toEqual(callEvidence(before.calls));
  expect(f.browserRuns[0]!.prompt).toContain("Current appended work checkpoint.");
  expect(f.browserRuns[0]!.prompt).not.toContain(e.firstResult!.output);
  expect(f.browserRuns[0]!.key).not.toBe(e.pageKey);
  await f.finish();
  expect((await recovered).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(0);
  expect(Object.keys(f.record().calls)).toEqual([e.callId]);
  expect(e.sends + f.sends()).toBe(3);
  expect(e.dispatches).toBe(1);
}, 30_000);

test("recovery v3: explicit stop keeps A and appended B stopped after restart and new C starts one new epoch", async () => {
  const { f, evidence: e } = await exitedBackendChain("stop");
  const before = f.record();
  for (const input of [e.originalInput, [...e.appendInput, e.firstResult!]]) {
    await expect(f.run(f.request(input))).rejects.toMatchObject({ code: "continuity_stopped", retryable: false });
  }
  expect(f.record()).toEqual(before);
  expect(f.submissions()).toBe(0);
  const events: AdapterEvent[] = [];
  const next = f.run(f.request([...e.appendInput, e.firstResult!, user("new-C", "Start a new explicit task.")]), events);
  await f.waitSubmission(1);
  const active = f.record();
  const newWork = active.works[active.currentWorkId!]!;
  expect(active.epoch).toBe(before.epoch + 1);
  expect(newWork.logicalWorkId).not.toBe(e.sourceLogicalWorkId);
  expect(newWork.logicalWorkId).not.toBe(e.headLogicalWorkId);
  expect(newWork.workLineageId).not.toBe(e.lineageId);
  expect(newWork.predecessorLogicalWorkId).toBeUndefined();
  expect(newWork.acceptedTaskRevision).toBe(before.works[e.sourceLogicalWorkId]!.acceptedTaskRevision);
  expect(newWork.attempts).toHaveLength(1);
  expect(newWork.attempts[0]).toMatchObject({ attempt: 0, epoch: 1, stage: "accepted" });
  expect(active.lineages[newWork.workLineageId]).toMatchObject({ rootLogicalWorkId: newWork.logicalWorkId,
    headLogicalWorkId: newWork.logicalWorkId, acceptedTaskRevision: newWork.acceptedTaskRevision, toolBatchHeadSequence: 0 });
  expect(active.works[e.sourceLogicalWorkId]).toEqual(before.works[e.sourceLogicalWorkId]);
  expect(active.works[e.headLogicalWorkId]).toEqual(before.works[e.headLogicalWorkId]);
  expect(callEvidence(active.calls)).toEqual(callEvidence(before.calls));
  expect(f.browserRuns[0]!.key).not.toBe(e.pageKey);
  await f.finish();
  expect((await next).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(events.some(event => event.type === "tool_call_start")).toBeFalse();
  expect(e.sends + f.sends()).toBe(2);
  expect(e.dispatches).toBe(1);
  for (const input of [e.originalInput, [...e.appendInput, e.firstResult!]]) {
    await expect(f.run(f.request(input))).rejects.toMatchObject({ code: "continuity_stopped", retryable: false });
  }
  expect(f.submissions()).toBe(1);
}, 30_000);
