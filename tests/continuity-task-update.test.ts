import { afterEach, expect, spyOn, test } from "bun:test";
import { $ } from "bun";
import { harmlessContinuityCommand } from "./helpers/continuity-command";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { ContinuityRecoveryStore, continuityProcessInstance, continuityProcessInstanceStatus, type RecoveryCallRecord } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, sameContinuityRecoveryIdentity, type ContinuityLease, type ContinuityRecoveryIdentity } from "../src/adapters/chatgpt-web/continuity-contract";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "./helpers/chatgpt-web-adapter";
import { chatGptTurnExecutionKey, chatGptTurnSessions, TASK_UPDATE_SESSION_JOURNAL_BYTES } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { NativeOperationReply } from "../src/adapters/chatgpt-web/native-tool-operations";
import type { TaskUpdateTransfer, TaskUpdateTransferOutcome, UpdateDelivery } from "../src/adapters/chatgpt-web/task-update-protocol";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { defaultBrokerEndpoint } from "../src/config";
import { CONTINUITY_EXECUTION_FENCING_FEATURE, LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { parseRequest } from "../src/responses/parser";
import { encodeCompactionSummary } from "../src/responses/compaction";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const cleanup: Array<() => Promise<void>> = [];
const faultRestorations: Array<() => void> = [];
afterEach(async () => {
  for (const restore of faultRestorations.splice(0).reverse()) restore();
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
const issuedCall = (id: string, cmd = "simulated only") => ({ type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd }) });
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
  options: { root?: string; preserveRoot?: boolean; remote?: boolean; fresh?: boolean;
    manualPrepared?: (count: number) => void; manualSent?: (count: number) => Promise<void>;
    completionInspection?: { entered(): void; release: Promise<void> } } = {}) {
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
    if (path.endsWith("continuity-capacity")) return Response.json({ ok: true, executionProtocol: 1, available: true });
    const body = await request.json() as { conversationKey: string; expected: ContinuityLease; recovery?: ContinuityLease["recovery"] };
    if (options.completionInspection) {
      const record = new ContinuityRecoveryStore(statePath).get(continuityDigest(root));
      if (record?.currentWorkId && record.works[record.currentWorkId]?.state === "completed") {
        options.completionInspection.entered();
        await options.completionInspection.release;
      }
    }
    if (path.includes("continuity-") && body.recovery) {
      const action = path.slice(path.lastIndexOf("continuity-") + "continuity-".length);
      coordination.push({ action, recovery: structuredClone(body.recovery) });
      const receipt = receipts.find(value => sameContinuityRecoveryIdentity(value.recovery, body.recovery!));
      if (!receipt) return action === "query"
        ? Response.json({ ok: true, executionProtocol: 1, recovery: body.recovery, launcherInstance, hostNoWriter: pages.size === 0,
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
      return Response.json({ ok: true, executionProtocol: 1, recovery: receipt.recovery, state: receipt.state,
        launcherInstance, hostNoWriter: receipt.writerRetired && !pages.has(receipt.key),
        writerRetired: receipt.writerRetired, executionIsolated: receipt.writerRetired, physicalCleanup: receipt.writerRetired ? "destroyed" : "pending", toolsSettled: false, ...(sendAuthorized === undefined ? {} : { sendAuthorized }) });
    }
    const page = pages.get(body.conversationKey);
    if (new URL(request.url).pathname.endsWith("release")) { pages.delete(body.conversationKey); return Response.json({ ok: true, released: 1 }); }
    return page && JSON.stringify(page.continuity) === JSON.stringify(body.expected)
      ? Response.json({ ok: true, ...page }) : Response.json({ ok: false, code: "continuity_session_lost" }, { status: 409 });
  } });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development",
    pid: process.pid, launcherInstance, features: [CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, CONTINUITY_EXECUTION_FENCING_FEATURE], endpoint: `http://127.0.0.1:${server.port}`,
    control: { endpoint: `http://127.0.0.1:${server.port}`, token: "a".repeat(43) },
    helper: { executable: process.execPath, script: import.meta.path }, partition: "persist:codex-web-gpt-dev-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString() }), { mode: 0o600 });
  const statePath = join(root, "state");
  new ContinuityRegistrationStore(statePath).initialize();
  const socket = defaultBrokerEndpoint(root);
  // Keep the simulated update/ACK model on the existing inline startup contract.
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `fixture://${root}`, chatgptWeb: { maxComposerCodePoints: 2_000_000,
    browserHost: "launcher", browserHostDescriptorPath: descriptorPath, continuityStateDirectory: statePath,
    browserInteractionMode: manual ? "manual" : "automatic", brokerSocketPath: socket,
    experimentalFreshConversationPerTurn: options.fresh,
    localToolsEnabled: true, toolAuthorityMode: "delegated", solAvailable: !manual, zeroRiskRequireSentConfirmation: true,
  } };
  const broker = TurnBroker.forSocket(socket);
  // The simulated update consumer uses the original inline/on-demand ABI.
  const reuseCapability = spyOn(broker, "contextReuseAvailable").mockReturnValue(false);
  faultRestorations.push(() => reuseCapability.mockRestore());
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
      const control = compiled.text.match(/turn_token (turn_[a-f0-9]{32})/)![1]!;
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
  const manualPrompts: string[] = [];
  const manualControl: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      submissions++;
      physicalKey = activity.conversationKey!;
      const continuity = { owner: activity.continuity!.owner, leaseId: "1".repeat(32), traceId: activity.traceId, recovery: activity.continuity!.recovery };
      acquire(physicalKey, continuity, "send-possible");
      manualPrompts.push(activity.prompt);
      options.manualPrepared?.(manualPrompts.length);
      token = JSON.parse(activity.prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)\n/)![1]!).request_id;
      return { continuity };
    },
    async waitSent() { await options.manualSent?.(manualPrompts.length); broker.startSafeTurn(token); sendActivations++; },
    waitTerminal: () => new Promise<never>(() => {}),
    async markStarted() { ready.resolve({ token }); },
    async end() { const page = pages.get(physicalKey); if (page) page.state = "ready"; },
    async cancel() {},
  };
  const originalAccept = broker.acceptTaskUpdate;
  if (!protocol) broker.acceptTaskUpdate = undefined as never;
  if (options.remote) await broker.listen();
  const owner = options.remote ? new RemoteTurnBroker(socket) : broker;
  if (owner instanceof RemoteTurnBroker) {
    const remoteReuseCapability = spyOn(owner, "contextReuseAvailable").mockResolvedValue(false);
    faultRestorations.push(() => remoteReuseCapability.mockRestore());
  }
  const adapter = createChatGptWebAdapter(provider, { broker: owner, zeroRiskManualControl: manualControl });
  const request = (input: unknown[] = [user("initial-user", "Inspect the project.")], requestId = "request") => {
    const parsed = parseRequest({ model: manual ? CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL : "gpt-5.6-sol",
      stream: false, input, tools: [{ type: "function", name: "exec_command", description: "Simulated tool",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
      ...(search ? [{ type: "tool_search", description: "Simulated discovery", parameters: { type: "object" } }] : [])],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: root, turn_id: "turn", request_id: requestId }) } });
    parsed._conversationPolicy = "task";
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
  }, null);
  const wait = (operationId: number) => callTurnBroker<NativeOperationReply & { taskUpdate?: UpdateDelivery }>(socket, {
    method: "native_operation_wait", token, contract, nativeWaitProtocol: 1, operationId, waitMs: 1,
  }, null);
  const startTool = (operationId: number, wireName: string, taskRevision = 0) => callTurnBroker<NativeOperationReply & { taskUpdate?: UpdateDelivery }>(socket, {
    method: "native_operation_start", token, contract, nativeWaitProtocol: 1, taskUpdateProtocol: 1, taskRevision,
    operationId, entry: "codex_tool_call", nativeInput: { wire_name: wireName, arguments: {} }, waitMs: 1,
  }, null);
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
    pages, provider, adapter, startTool, socket, root, statePath, browserRuns, coordination, waitSubmission, manualPrompts,
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

test("page task receipts and ACK publications end with their retired capability", async () => {
  const f = await fixture();
  const [call] = await batch(f);
  const accept = f.broker.acceptTaskUpdate.bind(f.broker);
  let accepted: { token: string; transfer: TaskUpdateTransfer; outcome: TaskUpdateTransferOutcome } | undefined;
  const traced = spyOn(f.broker, "acceptTaskUpdate").mockImplementation((token, transfer) => {
    const outcome = accept(token, transfer);
    if (outcome.status === "committed") accepted = structuredClone({ token, transfer, outcome });
    return outcome;
  });
  cleanup.push(async () => { traced.mockRestore(); });
  const running = f.run(f.request([output(call!.id), user("append", "Also inspect tests.")]));
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  f.ack(reply.taskUpdate!);
  expect(accepted?.outcome.status).toBe("committed");
  expect(accept(accepted!.token, accepted!.transfer)).toEqual(accepted!.outcome);
  const directory = f.broker.taskUpdateState(f.token())!.acknowledgementDirectory!;
  expect(existsSync(directory)).toBeTrue();
  const buffered = deferred<void>(), release = deferred<void>();
  const relayPath = join(f.root, "delayed-receipt.sock");
  const relay = createServer(socket => {
    const upstream = createConnection(f.socket);
    const chunks: Buffer[] = [];
    socket.pipe(upstream);
    upstream.on("data", chunk => { chunks.push(Buffer.from(chunk)); });
    upstream.on("end", () => {
      buffered.resolve();
      void release.promise.then(() => socket.end(Buffer.concat(chunks)));
    });
    upstream.on("error", error => socket.destroy(error));
    socket.on("error", () => {});
  });
  await new Promise<void>(resolve => relay.listen(relayPath, resolve));
  cleanup.push(async () => { release.resolve(); await new Promise<void>(resolve => relay.close(() => resolve())); });
  const originalReply = new RemoteTurnBroker(relayPath).acceptTaskUpdate(accepted!.token, accepted!.transfer);
  await buffered.promise;
  await f.finish();
  expect((await running).at(-1)).toMatchObject({ type: "done", endTurn: true });
  // The session retires only after its admitted request and physical worker have settled.
  await f.broker.revokeTrusted(f.token());
  expect(f.broker.taskUpdateState(f.token())).toBeUndefined();
  expect(existsSync(directory)).toBeFalse();
  expect(() => accept(accepted!.token, accepted!.transfer)).toThrow();
  release.resolve();
  expect(await originalReply).toEqual(accepted!.outcome);
  // The real RPC response was buffered before retirement and delivered afterward.
  expect(accepted!.outcome).toMatchObject({ status: "committed", state: { acceptedRevision: 1 } });
  expect(await callTurnBroker(f.socket, { method: "owner_status" })).toHaveProperty("protocolVersion");
});

for (const close of [false, true]) test(`page ACK cleanup failure cannot interrupt ${close ? "shutdown" : "trace retirement"} of another capability`, async () => {
  const f = await fixture();
  const [call] = await batch(f);
  f.broker.completeTool(f.token(), call!.id, { content: [{ type: "text", text: "original result" }] }, { expectedDriverGeneration: 0, taskRevision: 0 });
  const directory = f.broker.taskUpdateState(f.token())!.acknowledgementDirectory!;
  const sibling = await f.broker.register({ authorityMode: "delegated", threadId: "cleanup-sibling", turnId: "turn", tools: [{
    name: "exec_command", description: "Unused inert test capability", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
  }] }, undefined, f.browserRuns[0]!.turn.traceId, { taskUpdateProtocol: 1 });
  const waiting = f.broker.nextToolBatch(f.token(), undefined, { expectedDriverGeneration: 0, taskRevision: 0 })
    .then(() => false, () => true);
  const siblingWaiting = f.broker.nextToolBatch(sibling, undefined, { expectedDriverGeneration: 0, taskRevision: 0 })
    .then(() => false, () => true);
  const remove = fs.rmSync;
  let failRemoval = true;
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const failure = spyOn(fs, "rmSync").mockImplementation((path, options) => {
    if (path === directory && failRemoval) {
      if (close) failRemoval = false; // Shutdown retries the failed publication after revoking every channel.
      throw Object.assign(new Error("ACK directory cleanup failed"), { code: "EACCES" });
    }
    return remove(path, options);
  });
  try {
    if (close) await f.broker.close();
    else expect(f.broker.revokeTrace(f.browserRuns[0]!.turn.traceId)).toBe(2);
    expect(await waiting).toBeTrue();
    expect(await siblingWaiting).toBeTrue();
    expect(f.broker.taskUpdateState(f.token())).toBeUndefined();
    expect(errors.mock.calls.some(([message]) => String(message).includes('broker_ack_cleanup_failed {"code":"EACCES"}'))).toBeTrue();
    const start = callTurnBroker(f.socket, { method: "native_operation_start", token: sibling, contract: "native",
      nativeWaitProtocol: 1, taskUpdateProtocol: 1, taskRevision: 0, operationId: 1, entry: "codex_exec", nativeInput: { cmd: "never executed" }, waitMs: 1 });
    if (close) await expect(start).rejects.toThrow();
    else await expect(start).rejects.toMatchObject({ code: "codex_tool_operation_retired" });
    failRemoval = false;
    if (!close) await f.broker.close();
    expect(existsSync(directory)).toBeFalse();
  } finally {
    failure.mockRestore(); errors.mockRestore(); remove(directory, { recursive: true, force: true });
  }
});

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
    expect(f.record().currentWorkId).toBe(before.currentWorkId);
    expect(f.record().calls[call!.id]).toMatchObject({ state: "settled", firstResultDigest: recoveryResultDigest(output(call!.id)) });
    const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
    const queue = taskInputQueue(session)!;
    expect(queue.store.get(queue.identity)?.messages[0]).toMatchObject({ messageId: "rejected-B", status: "accepted" });
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
    if (this.directory === f.statePath && replaced && blocked) throw continuityError("continuity_configuration_conflict", "Durability confirmation temporarily unavailable");
    return confirm.call(this, thread, guard);
  });
  const transfers: TaskUpdateTransfer[] = [];
  const accept = f.broker.acceptTaskUpdate.bind(f.broker);
  const accepting = spyOn(f.broker, "acceptTaskUpdate").mockImplementation((token, transfer) => {
    insideAcceptance = true; transfers.push(structuredClone(transfer));
    try { return accept(token, transfer); } finally { insideAcceptance = false; }
  });
  faultRestorations.push(() => { accepting.mockRestore(); confirming.mockRestore(); reading.mockRestore(); transaction.mockRestore(); });
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
  if (blockReadback) {
    await expect(f.wait(1)).rejects.toThrow("Readback temporarily unavailable");
    await expect(f.broker.nextToolBatch(f.token(), undefined, { expectedDriverGeneration: 0, taskRevision: 0 }))
      .rejects.toMatchObject({ code: "continuity_configuration_conflict" });
    await expect(f.start(2, 0)).rejects.toThrow("Readback temporarily unavailable");
  } else {
    expect(await f.wait(1)).toMatchObject({ kind: "pending" });
    await expect(f.broker.nextToolBatch(f.token(), undefined, { expectedDriverGeneration: 1, taskRevision: 1 }))
      .rejects.toMatchObject({ code: "task_update_transfer_pending" });
    const blockedDecision = await f.start(2, 1);
    expect(blockedDecision).toMatchObject({ kind: "result", result: { isError: true } });
    expect(blockedDecision.kind === "result" && blockedDecision.result.content[0]).toMatchObject({ type: "text",
      text: expect.stringContaining('"reason":"transfer_pending"') });
  }
  blocked = false;
  const events: AdapterEvent[] = [];
  const running = f.run(f.request(input, "same-atomic-transfer"), events);
  void running.catch(() => {});
  const reconcileDeadline = Date.now() + 2_000;
  while (f.session().driverGeneration() !== 1
    || f.broker.taskUpdateTransferOutcome(f.token(), transferId).status !== "committed") {
    if (Date.now() >= reconcileDeadline) throw new Error("The original append transfer did not reconcile.");
    await Bun.sleep(1);
  }
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
  Object.assign(f.initial, f.request([output("accepted-history", "Accepted historical result."), user("initial-user", "Inspect the project.")]));
  const calls = await batch(f, 2);
  const accept = f.broker.acceptTaskUpdate.bind(f.broker);
  let lostReceipt = false;
  f.broker.acceptTaskUpdate = (token, transfer) => {
    const result = accept(token, transfer);
    if (!lostReceipt && result.status === "committed") { lostReceipt = true; throw new Error("Commit receipt lost"); }
    return result;
  };
  const first = f.request([output(calls[0]!.id), user("append", "Keep the first result."), output("accepted-history", "Accepted historical result.")]);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  expect(f.session().outstanding()).toHaveLength(1);
  const reply = await f.wait(1);
  expect(reply.kind).toBe("result");
  const retry = f.request([output(calls[0]!.id, "different retry body"),
    output("accepted-history", "Accepted historical result."), user("append", "Keep the first result.")], "new-transport-request");
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
  const abort = new AbortController();
  const queued = f.run(f.request([user("append", "Receive results when available.")]), [], abort.signal); void queued.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
  await f.start(4);
  let delivery = await f.wait(1);
  for (let i = 0; i < 100 && !delivery.taskUpdate; i++) { await Bun.sleep(2); delivery = await f.wait(1); }
  f.ack(delivery.taskUpdate!);
  abort.abort(); await queued.catch(() => {});
  const session = f.session();
  const storage = resultStorage(session);
  const large = "x".repeat(12 * 1024 * 1024);
  const largeOutput = (id: string) => ({ ...output(id), _meta: { raw: large } });
  const oversized = f.request(calls.map(call => largeOutput(call.id)));
  expect(() => { session.acceptContinuityToolResults(oversized); }).toThrow("capacity");
  expect(storage.continuityReceivedResults.size).toBe(0);
  const before = storage.taskUpdateStorageBytes();
  const beforeCanonicalBytes = Buffer.byteLength(JSON.stringify(session.canonicalInput()));
  session.acceptContinuityToolResults(f.request(calls.slice(0, 2).map(call => largeOutput(call.id))));
  expect(storage.continuityReceivedResults.size).toBe(2);
  expect(storage.continuityReceivedResultBytes).toBeGreaterThan(24 * 1024 * 1024);
  expect(storage.taskUpdateStorageBytes() - before).toBe(storage.continuityReceivedResultBytes
    + Buffer.byteLength(JSON.stringify(session.canonicalInput())) - beforeCanonicalBytes);
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
  await f.run(f.request([user("append", "Receive results when available."), output(calls[0]!.id, "completed repeat"), output(calls[1]!.id, "changed retry")], "retry-second"));
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
  const running = f.run(f.request([user("append", "Receive results when available."), output(calls[1]!.id, "changed retry"), output(calls[2]!.id, "changed retry")], "retry-rest"));
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

test("A7 continuity blocks completion before ACK and retains a late append after output lock", async () => {
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
  const lateAbort = new AbortController();
  const late = f.run(f.request([user("too-late")]), [], lateAbort.signal); void late.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && queue.store.get(queue.identity)?.messages.length !== 2; i++) await Bun.sleep(2);
  expect(queue.store.get(queue.identity)?.messages.at(-1)?.messageId).toBe("too-late");
  lateAbort.abort(); await late.catch(() => {});
  expect(f.session().taskRevision()).toBe(1);
  expect(f.session().isTaskUpdateCancelled()).toBeFalse();
  disconnected.abort(); await running.catch(() => {});
});

test("A3-A5 continuity receives two text-only inputs before the real result boundary", async () => {
  const f = await fixture();
  const [call] = await batch(f);
  const first = f.run(f.request([user("append-one", "First update.")])); void first.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
  const second = f.run(f.request([user("append-two", "Second update.")])); void second.catch(() => {});
  for (let i = 0; i < 100 && queue.store.get(queue.identity)?.messages.length !== 2; i++) await Bun.sleep(2);
  expect(queue.store.get(queue.identity)?.messages.map(message => message.receivedSequence)).toEqual([1, 2]);
  expect(f.broker.taskUpdateState(f.token())).toMatchObject({ acceptedRevision: 0, driverGeneration: 0 });
  const running = f.run(f.request([user("append-two", "Second update."), output(call!.id)]));
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  expect(reply.taskUpdate?.updates.map(update => update.content)).toEqual(["First update.", "Second update."]);
  f.ack(reply.taskUpdate!);
  await f.finish(); await running;
  expect(f.session().driverGeneration()).toBe(1);
  expect(f.submissions()).toBe(1);
  for (const response of await Promise.all([first, second])) expect(response.some(event => event.type === "incomplete")).toBeFalse();
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
  const abort = new AbortController();
  const queued = f.run(f.request([user("append")]), [], abort.signal); void queued.catch(() => {});
  await Bun.sleep(10);
  await expect(f.run(f.request([user("append", "conflicting text")]))).rejects.toMatchObject({ code: "task_update_message_conflict" });
  expect(f.session().taskRevision()).toBe(0);
  abort.abort(); await queued.catch(() => {});
  expect(f.session().isTaskUpdateCancelled()).toBeFalse();
});

for (const manual of [false, true]) for (const remote of [false, true]) test(`${remote ? "Remote" : "Local"} ${manual ? "Zero Risk" : "Automatic"} retains a reserved append across ACK and a lost commit receipt`, async () => {
  const f = await fixture(manual, true, false, { remote });
  const [call] = await batch(f);
  const firstRunning = f.run(f.request([user("first-append", "First update."), output(call!.id)], "first-append"));
  let firstReply = await f.wait(1);
  while (firstReply.kind !== "result") firstReply = await f.wait(1);
  const originalReserve = f.broker.reserveTaskUpdate.bind(f.broker);
  let transferId: string | undefined;
  const reserve = spyOn(f.broker, "reserveTaskUpdate").mockImplementation((...args) => {
    const receipt = originalReserve(...args);
    transferId = args[1];
    f.ack(firstReply.taskUpdate!);
    return receipt;
  });
  const originalAccept = f.broker.acceptTaskUpdate.bind(f.broker);
  let receiptLost = false;
  const accept = spyOn(f.broker, "acceptTaskUpdate").mockImplementation((...args) => {
    const receipt = originalAccept(...args);
    if (!receiptLost && receipt.status === "committed") {
      receiptLost = true;
      throw new Error("Lost committed append receipt after ACK");
    }
    return receipt;
  });
  cleanup.push(async () => { reserve.mockRestore(); accept.mockRestore(); });
  const second = f.request([user("second-append", "Second update.")], "second-append");
  const secondRunning = f.run(second);
  f.ack(firstReply.taskUpdate!);
  let reply = await f.wait(1);
  for (let i = 0; i < 100 && !reply.taskUpdate?.updates.some(update => update.sourceMessageId === "second-append"); i++) { await Bun.sleep(2); reply = await f.wait(1); }
  expect(receiptLost).toBeTrue();
  expect(reply.kind).toBe("result");
  expect(reply.taskUpdate?.updates.map(update => update.sourceMessageId)).toEqual(["second-append"]);
  expect(f.broker.taskUpdateTransferOutcome(f.token(), transferId!)).toMatchObject({ status: "committed" });
  expect(f.broker.taskUpdateState(f.token())).toMatchObject({ acceptedRevision: 2, driverGeneration: 2, acknowledgedRevision: 1 });
  f.ack(reply.taskUpdate!);
  await f.finish();
  expect((await secondRunning).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect((await firstRunning).some(event => event.type === "incomplete")).toBeFalse();
  expect((await f.run(f.request([user("second-append", "Second update.")], "second-append-retry"))).at(-1))
    .toMatchObject({ type: "done", endTurn: true });
  expect(f.session().taskRevision()).toBe(2);
  expect(f.session().driverGeneration()).toBe(2);
  expect(f.submissions()).toBe(1);
});

for (const manual of [false, true]) test(`Remote ${manual ? "Zero Risk" : "Automatic"} recovers a lost reservation receipt while draining`, async () => {
  const f = await fixture(manual, true, false, { remote: true });
  const [call] = await batch(f);
  const originalReserve = f.broker.reserveTaskUpdate.bind(f.broker);
  let receiptLost = false;
  const transferIds: string[] = [];
  const reserve = spyOn(f.broker, "reserveTaskUpdate").mockImplementation((...args) => {
    transferIds.push(args[1]);
    const receipt = originalReserve(...args);
    if (!receiptLost) {
      receiptLost = true;
      f.broker.setExternalOwnersAccepted(false);
      throw new Error("Lost reservation receipt while entering drain");
    }
    return receipt;
  });
  cleanup.push(async () => { reserve.mockRestore(); });
  const running = f.run(f.request([user("append", "Include validation."), output(call!.id)], "append"));
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  expect(receiptLost).toBeTrue();
  expect(transferIds).toHaveLength(2);
  expect(new Set(transferIds).size).toBe(1);
  expect(reply.taskUpdate?.updates.map(update => update.sourceMessageId)).toEqual(["append"]);
  f.ack(reply.taskUpdate!);
  await f.finish();
  expect((await running).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.session().taskRevision()).toBe(1);
  expect(f.session().driverGeneration()).toBe(1);
  expect(f.session().hasPendingTaskUpdate()).toBeFalse();
  expect(f.submissions()).toBe(1);
});

for (const remote of [false, true]) test(`${remote ? "Remote" : "Local"} Zero Risk drains its owner tool wait after durable completion without restoring writer authority`, async () => {
  const inspected = deferred<void>();
  const inspectionRelease = deferred<void>();
  const f = await fixture(true, true, false, { remote,
    completionInspection: { entered: () => inspected.resolve(), release: inspectionRelease.promise } });
  const [call] = await batch(f);
  const originalReserve = f.broker.reserveTaskUpdate.bind(f.broker);
  const transferIds: string[] = [];
  const reserve = spyOn(f.broker, "reserveTaskUpdate").mockImplementation((...args) => {
    transferIds.push(args[1]);
    const receipt = originalReserve(...args);
    if (transferIds.length === 1) {
      f.broker.setExternalOwnersAccepted(false);
      throw new Error("Lost reservation receipt while entering drain");
    }
    return receipt;
  });
  const originalNext = f.broker.nextToolBatch.bind(f.broker);
  const originalObserve = f.broker.waitForTaskUpdateState.bind(f.broker);
  let observationCalls = 0;
  const observe = spyOn(f.broker, "waitForTaskUpdateState").mockImplementation((...args) => {
    observationCalls += 1;
    return originalObserve(...args);
  });
  const nextEntered = deferred<void>();
  const nextResult = deferred<unknown>();
  const next = spyOn(f.broker, "nextToolBatch").mockImplementation((...args) => {
    nextEntered.resolve();
    const result = inspected.promise.then(() => originalNext(...args));
    void result.then(nextResult.resolve, nextResult.reject);
    return result;
  });
  cleanup.push(async () => { next.mockRestore(); reserve.mockRestore(); observe.mockRestore(); });
  try {
    const running = f.run(f.request([user("append", "Include validation."), output(call!.id)], "append"));
    let reply = await f.wait(1);
    while (reply.kind !== "result") reply = await f.wait(1);
    expect(transferIds).toHaveLength(2);
    expect(new Set(transferIds).size).toBe(1);
    expect(reply.taskUpdate?.updates.map(update => update.sourceMessageId)).toEqual(["append"]);
    f.ack(reply.taskUpdate!);
    await nextEntered.promise;
    await f.finish();
    await inspected.promise;
    const completed = f.record();
    const work = completed.works[completed.currentWorkId!]!;
    expect(work.state).toBe("completed");
    expect(work.attempts.at(-1)).toMatchObject({ stage: "completed", writerRetired: true });
    expect(work.taskUpdateJournal).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 1, driverGeneration: 1 });
    const completedObservationCalls = observationCalls;
    const taskObservers = (f.broker as unknown as { channels: Map<string, { taskUpdates: { observers: Set<unknown> } }> })
      .channels.get(f.token())!.taskUpdates.observers;
    expect(taskObservers.size).toBe(0);
    expect(await nextResult.promise).toEqual([]);
    await expect(originalNext(f.token(), undefined, { expectedDriverGeneration: 0, taskRevision: 0 }))
      .rejects.toMatchObject({ code: "task_update_driver_stale" });
    await expect(originalNext(f.token(), undefined, { expectedDriverGeneration: 1, taskRevision: 0 }))
      .rejects.toMatchObject({ code: "task_update_revision_stale" });
    expect(() => f.ack(reply.taskUpdate!)).toThrow("An obsolete execution cannot write to the current recovery attempt");
    await expect(f.start(2, 1)).rejects.toThrow("An obsolete execution cannot write to the current recovery attempt");
    expect(f.record()).toEqual(completed);
    expect(f.broker.taskOutputReceipt(f.token())).toMatchObject({ kind: "completed", taskRevision: 1, driverGeneration: 1 });
    expect(observationCalls).toBe(completedObservationCalls);
    expect(taskObservers.size).toBe(0);
    inspectionRelease.resolve();
    expect((await running).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(f.submissions()).toBe(1);
  } finally { inspectionRelease.resolve(); }
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} queues at a consumed boundary and delivers before the next Native decision`, async () => {
  const f = await fixture(manual);
  const [firstCall] = await batch(f);
  const resultEvents: AdapterEvent[] = [];
  const resultRound = f.run(f.request([user("initial-user", "Inspect the project."), output(firstCall!.id)], "first-result"), resultEvents);
  void resultRound.catch(() => {});
  let firstReply = await f.wait(1);
  while (firstReply.kind !== "result") firstReply = await f.wait(1);
  expect(f.session().outstanding()).toHaveLength(0);
  const events: AdapterEvent[] = [];
  const appended = f.run(f.request([user("append", "Also inspect tests.")], "append"), events); void appended.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
  expect(f.broker.taskUpdateState(f.token())).toMatchObject({ acceptedRevision: 0, driverGeneration: 0 });
  let reply = await f.start(2);
  for (let i = 0; i < 100 && !reply.taskUpdate; i++) { await Bun.sleep(2); reply = await f.wait(2); }
  expect(reply.taskUpdate?.updates.map(update => update.sourceMessageId)).toEqual(["append"]);
  expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(0);
  f.ack(reply.taskUpdate!);
  await f.finish();
  expect((await appended).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect((await resultRound).some(event => event.type === "incomplete")).toBeFalse();
  expect(f.submissions()).toBe(1);
});

test("A7-A9 continuity retains input with no boundary or old protocol without cancelling execution", async () => {
  for (const protocol of [true, false]) {
    const f = await fixture(false, protocol);
    const disconnected = new AbortController(), appendedAbort = new AbortController();
    const running = f.run(f.initial, [], disconnected.signal); void running.catch(() => {});
    await f.ready;
    const appended = f.run(f.request([user("append")]), [], appendedAbort.signal); void appended.catch(() => {});
    const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
    const queue = taskInputQueue(f.session())!;
    for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
    expect(queue.store.get(queue.identity)?.messages[0]?.status).toBe("accepted");
    expect(f.session().isActive()).toBeTrue();
    expect(f.session().isTaskUpdateCancelled()).toBeFalse();
    expect(f.submissions()).toBe(1);
    disconnected.abort(); appendedAbort.abort();
    await Promise.all([running.catch(() => {}), appended.catch(() => {})]);
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
  const abort = new AbortController();
  const update = f.run(f.request([output(call!.id), user("append")]), [], abort.signal); void update.catch(() => {});
  let reply = await f.wait(1);
  while (reply.kind !== "result") reply = await f.wait(1);
  f.ack(reply.taskUpdate!);
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
  abort.abort(); await update.catch(() => {});
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
  const changed = f.request([{ ...searchResult, tools: [{ ...discovered, description: "Replacement must be ignored." }] }, user("append")]);
  await f.run(changed);
  const unknown = f.request([{ ...searchResult, call_id: "unknown", tools: [{ ...discovered, name: "injected_tool" }] }, user("append")]);
  await expect(f.run(unknown)).rejects.toMatchObject({ code: "task_update_source_unproven" });
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
  const abort = new AbortController();
  const update = first.run(first.request([user("append")]), [], abort.signal); void update.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(physical)!;
  for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
  expect(queue.store.get(queue.identity)?.messages).toHaveLength(1);
  expect(first.session()).toBe(physical);
  expect(first.session().taskRevision()).toBe(0);
  expect(first.submissions()).toBe(1);
  expect(chatGptTurnSessions.activeCount()).toBe(5);
  const sixth = await fixture();
  await expect(sixth.run(sixth.initial)).rejects.toMatchObject({ code: "continuity_resource_capacity" });
  expect(sixth.submissions()).toBe(0);
  abort.abort(); await update.catch(() => {});
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
  const complete = f.request([user("initial-user", "Inspect the project."), ...calls.flatMap(call => [issuedCall(call.id), output(call.id)])]);
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
  sourceLogicalWorkId: string; headLogicalWorkId: string; lineageId: string; callId: string; argumentsText: string;
  originalInput: unknown[]; appendInput: unknown[]; firstResult?: ReturnType<typeof output>;
  sends: number; dispatches: number; pageKey: string; summary?: string; checkpointId?: string;
  failedTransfer?: Pick<TaskUpdateTransfer, "transferId" | "payloadDigest" | "batchFingerprint">;
  sourceSnapshotDigest?: string; headSnapshotDigest?: string;
  oldDelivery?: UpdateDelivery;
  owner: ReturnType<typeof continuityProcessInstance>;
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
      expect(head.attempts[0]).toMatchObject({ attempt: 0, epoch: committed.epoch, stage: "accepted" });
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
      const physical = f.session(); f.losePage();
      await physical.physicalSettlement;
      expect(f.broker.taskUpdateTransferOutcome(f.token(), transfers[0]!.transferId))
        .toMatchObject({ status: "unknown" });
      expect(f.record()).toBeUndefined();
      expect(f.submissions()).toBe(1);
      writeFileSync(join(root, "backend-chain-evidence.json"), JSON.stringify({ owner: issued.owner, sourceLogicalWorkId,
        headLogicalWorkId, lineageId: head.workLineageId, callId: call.id, argumentsText, originalInput, appendInput, firstResult,
        sends: f.sends(), dispatches: calls.length, pageKey: f.browserRuns[0]!.key,
        failedTransfer: { transferId: transfers[0]!.transferId, payloadDigest: transfers[0]!.payloadDigest,
          batchFingerprint: transfers[0]!.batchFingerprint },
        sourceSnapshotDigest: issued.works[sourceLogicalWorkId]!.attempts[0]!.snapshotDigest,
        headSnapshotDigest: head.attempts[0]!.snapshotDigest } satisfies BackendChainEvidence));
    } finally { unblock(); }
    return;
  }
  const appendInput = [...originalInput, ...(backendScenario === "checkpoint" ? [issuedCall(call.id, command)] : []),
    user("append", "Continue with the predecessor result.")];
  const appendAbort = new AbortController();
  const appendRunning = f.run(f.request(appendInput), [], appendAbort.signal); void appendRunning.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
  await f.start(2);
  let delivery = await f.wait(1);
  for (let i = 0; i < 100 && !delivery.taskUpdate; i++) { await Bun.sleep(2); delivery = await f.wait(1); }
  expect(delivery.kind).toBe("pending");
  expect(delivery.taskUpdate?.updates.map(update => update.sourceMessageId)).toEqual(["append"]);
  f.ack(delivery.taskUpdate!);
  appendAbort.abort(); await appendRunning.catch(() => {});
  const appended = f.record();
  const headLogicalWorkId = appended.currentWorkId!;
  const head = appended.works[headLogicalWorkId]!;
  const lineageId = head.workLineageId;
  expect(headLogicalWorkId).not.toBe(sourceLogicalWorkId);
  expect(head).toMatchObject({ predecessorLogicalWorkId: sourceLogicalWorkId,
    acceptedTaskRevision: issued.works[sourceLogicalWorkId]!.acceptedTaskRevision + 1,
    workLineageId: appended.works[sourceLogicalWorkId]!.workLineageId, state: "active" });
  expect(head.attempts).toHaveLength(1);
  expect(head.attempts[0]).toMatchObject({ attempt: 0, epoch: appended.epoch, stage: "accepted", writerRetired: false });
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
    const physical = f.session(); f.losePage();
    expect((await running).at(-1)?.type).toBe("error");
    await physical.physicalSettlement;
    expect(f.record()).toBeUndefined();
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
      expect(await f.start(3, 1)).toMatchObject({ kind: "result", result: { isError: true } });
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
      writeFileSync(join(root, "backend-chain-evidence.json"), JSON.stringify({ owner: issued.owner, sourceLogicalWorkId,
        headLogicalWorkId, lineageId, callId: call.id, argumentsText, originalInput, appendInput, firstResult,
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
      if (record) for (const id of [sourceLogicalWorkId, headLogicalWorkId]) {
        expect(record.works[id]).toMatchObject({ state: "stopped", stopReason: "user-stop", workLineageId: lineageId });
      }
    }
  }
  expect(f.submissions()).toBe(1);
  writeFileSync(join(root, "backend-chain-evidence.json"), JSON.stringify({ owner: issued.owner, sourceLogicalWorkId,
    headLogicalWorkId, lineageId, callId: call.id, argumentsText, originalInput, appendInput, firstResult,
    sends: f.sends(), dispatches: calls.length, pageKey: f.browserRuns[0]!.key,
    oldDelivery: delivery.taskUpdate } satisfies BackendChainEvidence));
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
  expect(evidence.owner.pid).toBe(child.pid);
  const ownerStatus = continuityProcessInstanceStatus(evidence.owner);
  if (evidence.owner.startIdentity === "unverified") expect(ownerStatus).toBe("unverified");
  else expect(ownerStatus).toBe("exited");
  expect(f.submissions()).toBe(0);
  expect(f.sends()).toBe(0);
  return { f, evidence, ownerStatus };
}

function recoveredCallInput(evidence: BackendChainEvidence): unknown[] {
  // The child captured these bytes from the actual emitted tool_call_delta events.
  // Journal digests only verify this body; they never reconstruct it.
  return [...evidence.originalInput,
    { type: "function_call", call_id: evidence.callId, name: "exec_command", arguments: evidence.argumentsText },
    ...evidence.appendInput.slice(evidence.originalInput.length)];
}

for (const scenario of ["recover", "stop", "checkpoint", "publication-exit"] as const) test(`page lifetime: actual backend exit restores current input after ${scenario}`, async () => {
  const { f, evidence: e } = await exitedBackendChain(scenario);
  const input = scenario === "checkpoint"
    ? [{ type: "compaction", encrypted_content: encodeCompactionSummary(e.summary!) }, user("current-after-checkpoint", "Complete the current task from this summary.")]
    : [...recoveredCallInput(e), ...(e.firstResult ? [e.firstResult] : [])];
  const events: AdapterEvent[] = [];
  const restored = f.run(f.request(input), events);
  await f.waitSubmission(1);
  const active = f.record(), current = active.works[active.currentWorkId!]!;
  expect(current.logicalWorkId).not.toBe(e.sourceLogicalWorkId);
  expect(current.logicalWorkId).not.toBe(e.headLogicalWorkId);
  expect(current.predecessorLogicalWorkId).toBeUndefined();
  expect(current.attempts).toHaveLength(1); expect(current.attempts[0]!.attempt).toBe(0);
  expect(Object.keys(active.works)).toHaveLength(1); expect(Object.keys(active.calls)).toHaveLength(0);
  expect(Object.keys(active.checkpoints)).toHaveLength(0);
  expect(f.browserRuns[0]!.key).not.toBe(e.pageKey);
  expect(f.browserRuns[0]!.prompt).toContain(scenario === "checkpoint" ? "Complete the current task" : "Continue with the predecessor result.");
  if (e.oldDelivery) expect(() => f.ack(e.oldDelivery!)).toThrow();
  await f.finish();
  expect((await restored).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(0);
  expect(e.dispatches).toBe(1); expect(e.sends + f.sends()).toBe(scenario === "checkpoint" ? 3 : 2);
  if (scenario === "recover") expect(readFileSync(join(f.root, "harmless-command-count"), "utf8")).toBe("x");
}, 30_000);

test("Q04 queued text without tools continues in a second physical response", async () => {
  const f = await fixture();
  const firstEvents: AdapterEvent[] = [], nextEvents: AdapterEvent[] = [];
  const first = f.run(f.initial, firstEvents); void first.catch(() => {});
  await f.ready;
  const queued = f.run(f.request([user("queued-no-tools", "Also inspect the tests.")], "queued"), nextEvents);
  void queued.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
  expect(queue.store.get(queue.identity)?.messages.map(message => message.messageId)).toEqual(["queued-no-tools"]);
  expect(f.broker.taskUpdateState(f.token())).toMatchObject({ acceptedRevision: 0, driverGeneration: 0 });
  await f.finish();
  await f.waitSubmission(2);
  expect(f.sends()).toBe(2);
  expect(f.browserRuns[1]!.prompt).toContain("Also inspect the tests.");
  expect(f.broker.taskUpdateState(f.token())).toMatchObject({ acceptedRevision: 0, driverGeneration: 0 });
  await f.finish();
  expect((await queued).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(nextEvents.some(event => event.type === "assistant_boundary")).toBeTrue();
  expect(nextEvents.filter(event => event.type === "done" && event.endTurn)).toHaveLength(1);
  expect(queue.store.get(queue.identity)?.messages[0]?.status).toBe("completed");
  expect((await first).some(event => event.type === "incomplete")).toBeFalse();
});

test("Q01 queued activity keeps the issued call and delivers an ordered ACK batch", async () => {
  const f = await fixture();
  const [call] = await batch(f);
  const events: AdapterEvent[] = [];
  const response = f.run(f.request([output(call!.id, "real completed result"), user("first-queued", "First update."), user("second-queued", "Second update.")], "updates"), events);
  void response.catch(() => {});
  let reply = await f.wait(1);
  for (let i = 0; i < 100 && (!reply.taskUpdate || reply.kind !== "result"); i++) { await Bun.sleep(2); reply = await f.wait(1); }
  expect(reply.kind).toBe("result");
  expect(reply.taskUpdate?.updates.map(update => update.sourceMessageId)).toEqual(["first-queued", "second-queued"]);
  expect(reply.taskUpdate?.updates.map(update => update.revision)).toEqual([1, 2]);
  expect(f.broker.taskUpdateState(f.token())).toMatchObject({ acceptedRevision: 2, driverGeneration: 1 });
  f.ack(reply.taskUpdate!);
  await f.finish();
  expect((await response).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.sends()).toBe(1);
  expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(0);
});

test("Q10 detached observers retain input without starting a follow-up Send", async () => {
  const f = await fixture();
  const firstAbort = new AbortController(), secondAbort = new AbortController();
  const first = f.run(f.initial, [], firstAbort.signal); void first.catch(() => {});
  await f.ready;
  const appended = f.request([user("offline-input", "Keep this input for reconnect.")], "offline");
  const second = f.run(appended, [], secondAbort.signal); void second.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
  firstAbort.abort(); secondAbort.abort();
  await Promise.allSettled([first, second]);
  await f.finish(); await f.session().browserOutcome; await f.session().physicalSettlement;
  await Bun.sleep(10);
  expect(f.sends()).toBe(1);
  expect(queue.store.get(queue.identity)?.messages[0]?.status).toBe("accepted");
  expect(queue.store.readBody(queue.identity, "offline-input")).toBe("Keep this input for reconnect.");
  const reconnected = f.run(f.request([user("offline-input", "Keep this input for reconnect.")], "reconnect"));
  void reconnected.catch(() => {});
  await f.waitSubmission(2); await f.finish();
  expect((await reconnected).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(queue.store.get(queue.identity)?.receivedSequence).toBe(1);
});

test("Q05 input after final lock keeps the original output version and follows normally", async () => {
  const f = await fixture();
  const first = f.run(f.initial); void first.catch(() => {});
  await f.ready;
  const locked = f.broker.beginFinalOutput(f.token(), { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 });
  const later = f.run(f.request([user("after-lock", "Follow-up after the final lock.")], "after-lock"));
  void later.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
  expect(f.broker.taskUpdateState(f.token())).toMatchObject({ acceptedRevision: 0, driverGeneration: 0, finalOutputRevision: 0 });
  expect(f.broker.taskOutputReceipt(f.token())).toEqual(locked);
  await f.finish(); await f.waitSubmission(2); await f.finish();
  expect((await later).at(-1)).toMatchObject({ type: "done", endTurn: true });
  await first;
  expect(f.sends()).toBe(2);
});

test("Q15 an old active protocol receives input for normal follow-up without upgrade", async () => {
  const f = await fixture(false, false);
  const first = f.run(f.initial); void first.catch(() => {});
  await f.ready;
  const later = f.run(f.request([user("legacy-queued", "Continue after this old response.")], "legacy-queued"));
  void later.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
  expect(queue.store.get(queue.identity)?.receivedSequence).toBe(1);
  expect(f.session().taskUpdatesEnabled()).toBeFalse();
  await f.finish(); await f.waitSubmission(2); await f.finish();
  expect((await later).at(-1)).toMatchObject({ type: "done", endTurn: true });
  await first;
  expect(f.sends()).toBe(2);
});


test("Q06 Zero Risk receives while awaiting Sent and keeps each prepared prompt frozen", async () => {
  const prepared = [deferred<void>(), deferred<void>(), deferred<void>()];
  const sent = [deferred<void>(), deferred<void>(), deferred<void>()];
  const f = await fixture(true, true, false, { manualPrepared: count => prepared[count - 1]?.resolve(),
    manualSent: count => sent[count - 1]!.promise });
  const first = f.run(f.initial); void first.catch(() => {});
  await prepared[0]!.promise;
  const snapshot = f.manualPrompts[0];
  const second = f.run(f.request([user("manual-second", "Second prepared task.")], "manual-second")); void second.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
  expect(queue.store.get(queue.identity)?.waitReason).toBe("manual-send");
  expect(f.sends()).toBe(0); expect(f.manualPrompts[0]).toBe(snapshot);
  sent[0]!.resolve(); await f.ready; await f.finish(); await prepared[1]!.promise;
  expect(f.sends()).toBe(1); expect(f.manualPrompts[1]).toContain("Second prepared task.");
  const secondSnapshot = f.manualPrompts[1];
  const third = f.run(f.request([user("manual-third", "Third prepared task.")], "manual-third")); void third.catch(() => {});
  for (let i = 0; i < 100 && queue.store.get(queue.identity)?.messages.length !== 2; i++) await Bun.sleep(2);
  expect(queue.store.get(queue.identity)?.messages.map(message => message.receivedSequence)).toEqual([1, 2]);
  expect(f.manualPrompts[1]).toBe(secondSnapshot); expect(f.sends()).toBe(1);
  sent[1]!.resolve();
  for (let i = 0; i < 100 && f.sends() !== 2; i++) await Bun.sleep(2);
  await f.finish(); await prepared[2]!.promise;
  expect(f.sends()).toBe(2); expect(f.manualPrompts[2]).toContain("Third prepared task.");
  sent[2]!.resolve();
  for (let i = 0; i < 100 && f.sends() !== 3; i++) await Bun.sleep(2);
  await f.finish();
  expect((await third).at(-1)).toMatchObject({ type: "done", endTurn: true });
  await Promise.all([first, second]);
  expect(queue.store.get(queue.identity)?.messages.map(message => message.status)).toEqual(["completed", "completed"]);
});


test("Q08 compaction freezes its source while queued input continues under the committed history", async () => {
  const f = await fixture();
  const [call] = await batch(f);
  const current = [user("initial-user", "Inspect the project."), issuedCall(call!.id), output(call!.id), user("source-append", "Retain the original requirement.")];
  const originalAbort = new AbortController();
  const original = f.run(f.request(current, "source-result"), [], originalAbort.signal); void original.catch(() => {});
  let returned = await f.wait(1); while (returned.kind !== "result") returned = await f.wait(1);
  f.ack(returned.taskUpdate!);
  originalAbort.abort(); await original.catch(() => {});
  const requested = deferred<void>();
  const requestCompaction = f.broker.requestCompaction.bind(f.broker);
  const interception = spyOn(f.broker, "requestCompaction").mockImplementation((...args) => {
    const result = requestCompaction(...args); requested.resolve(); return result;
  });
  cleanup.push(async () => interception.mockRestore());
  const compact = f.request(current, "compact"); compact._compactionRequest = true;
  const compacting = f.run(compact); void compacting.catch(() => {});
  await Promise.race([requested.promise, compacting.then(() => { throw new Error("Compaction ended before interception"); })]);
  const events: AdapterEvent[] = [];
  const queued = f.run(f.request([user("during-compaction", "Apply this after the checkpoint.")], "during-compaction"), events); void queued.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && queue.store.get(queue.identity)?.messages.length !== 2; i++) await Bun.sleep(2);
  expect(queue.store.get(queue.identity)?.messages.at(-1)?.messageId).toBe("during-compaction");
  expect(queue.store.get(queue.identity)?.waitReason).toBe("compaction");
  expect(f.broker.taskUpdateState(f.token())).toMatchObject({ acceptedRevision: 1, driverGeneration: 1 });
  expect(await f.start(2, 1)).toMatchObject({ kind: "result", result: { isError: true } });
  await f.finish();
  await compacting;
  await Promise.race([f.waitSubmission(2), queued.then(() => { throw new Error(`Queued observer ended before continuation: ${JSON.stringify(events)}`); })]);
  expect(f.browserRuns[1]!.prompt).toContain("Apply this after the checkpoint.");
  expect(f.browserRuns[1]!.prompt).toContain("same retained conversation");
  expect(f.session().runtime.continuityBinding?.revision).toBe(1);
  const delivery = queue.store.get(queue.identity)?.deliveries.at(-1);
  expect(delivery).toMatchObject({ mode: "initial", acceptedRevision: 0, driverGeneration: 0, historyRevision: 1 });
  await f.finish();
  expect((await queued).at(-1)).toMatchObject({ type: "done", endTurn: true });
  originalAbort.abort(); await original.catch(() => {});
  expect(queue.store.get(queue.identity)?.messages.at(-1)?.status).toBe("completed");
});

test("Q09 page loss retains an undelivered input and binds it to the current recovery prompt", async () => {
  const f = await fixture();
  const first = f.run(f.initial); void first.catch(() => {});
  await f.ready;
  const saved = user("saved-before-loss", "Keep the queued requirement through page recovery.");
  const queued = f.run(f.request([saved], "before-loss")); void queued.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
  f.losePage();
  await Promise.allSettled([first, queued]);
  expect(queue.store.get(queue.identity)?.messages[0]?.status).toBe("accepted");
  const recovered = f.run(f.request([user("initial-user", "Inspect the project."), saved], "after-loss"));
  void recovered.catch(() => {});
  await Promise.race([f.waitSubmission(2), recovered.then(() => { throw new Error("Recovery ended before a new prompt"); })]);
  expect(queue.store.get(queue.identity)?.deliveries).toHaveLength(1);
  expect(queue.store.get(queue.identity)?.deliveries[0]).toMatchObject({ mode: "initial", messageIds: ["saved-before-loss"], acceptedRevision: 0, driverGeneration: 0 });
  expect(f.browserRuns[1]!.prompt).toContain("Keep the queued requirement through page recovery.");
  await f.finish();
  expect((await recovered).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(queue.store.get(queue.identity)?.messages[0]?.status).toBe("completed");
  expect(f.sends()).toBe(2);
});

test("Q15 old protocol rejects a mismatched tool result before receiving appended input", async () => {
  const f = await fixture(false, false);
  const [call] = await batch(f);
  const malformed = f.request([user("initial-user", "Inspect the project."), issuedCall(call!.id),
    { type: "tool_search_output", call_id: call!.id, status: "completed", tools: [] },
    user("legacy-invalid-result", "Only save this with a valid result.")], "legacy-invalid-result");
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  await expect(f.run(malformed)).rejects.toMatchObject({ code: "task_update_result_type_invalid" });
  expect(queue.store.get(queue.identity)).toBeUndefined();
  expect(f.sends()).toBe(1);
});

for (const protocol of [false, true]) for (const activeCall of [false, true]) test(`review R1 unknown result is rejected before receipt: protocol=${protocol}, activeCall=${activeCall}`, async () => {
  const f = await fixture(false, protocol);
  const abort = new AbortController();
  let initial: Promise<AdapterEvent[]> | undefined;
  if (activeCall) await batch(f);
  else { initial = f.run(f.initial, [], abort.signal); void initial.catch(() => {}); await f.ready; }
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  const before = f.record(), outstanding = f.session().outstanding();
  const failed = f.run(f.request([output("never-issued", "Invented result."), user("unknown-result-input", "Apply this later.")]), [], abort.signal);
  void failed.catch(() => {});
  try {
    await Promise.race([expect(failed).rejects.toMatchObject({ code: "task_update_source_unproven" }),
      Bun.sleep(200).then(() => { throw new Error("Unknown result was not rejected at admission"); })]);
    expect(queue.store.get(queue.identity)).toBeUndefined();
    expect(f.record()).toEqual(before);
    expect(f.session().outstanding()).toEqual(outstanding);
    expect(f.sends()).toBe(1);
  } finally { abort.abort(); await Promise.allSettled([failed, ...(initial ? [initial] : [])]); }
});

for (const fresh of [false, true]) test(`review R1 queued follow-up retains genuine final history only for a new page: fresh=${fresh}`, async () => {
  const f = await fixture(false, true, false, { fresh });
  const first = f.run(f.initial); void first.catch(() => {});
  await f.ready;
  const queued = f.run(f.request([user("follow-up-history", "Continue from the result just produced.")])); void queued.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
  await f.finish();
  await f.waitSubmission(2);
  const next = f.browserRuns[1]!;
  expect(next.key === f.browserRuns[0]!.key).toBe(!fresh);
  if (fresh) expect(next.prompt).toContain("Completed with the appended instruction.");
  else expect(next.prompt).not.toContain("Completed with the appended instruction.");
  await f.finish(); await queued; await first;
  expect(queue.store.get(queue.identity)?.state).toBe("completed");
  expect(f.sends()).toBe(2);
});

for (const fresh of [false, true]) test(`review R1 new-page continuation retains real tool context before final and queued input: fresh=${fresh}`, async () => {
  const inspecting = deferred<void>(), inspected = deferred<void>();
  const f = await fixture(false, true, false, { fresh,
    ...(!fresh ? { completionInspection: { entered: () => inspecting.resolve(), release: inspected.promise } } : {}) });
  const [call] = await batch(f);
  const resultObserver = f.run(f.request([user("initial-user", "Inspect the project."),
    issuedCall(call!.id), output(call!.id, "Verified repository state: clean.")]));
  void resultObserver.catch(() => {});
  let reply = await f.wait(1); while (reply.kind !== "result") reply = await f.wait(1);
  f.broker.beginFinalOutput(f.token(), { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 });
  const events: AdapterEvent[] = [];
  const queued = f.run(f.request([user("follow-real-tool", "Continue using the verified state.")]), events);
  void queued.catch(() => {});
  const { taskInputQueue } = await import("../src/adapters/chatgpt-web/continuity-task-input-runtime");
  const queue = taskInputQueue(f.session())!;
  for (let i = 0; i < 100 && !queue.store.get(queue.identity); i++) await Bun.sleep(2);
  await f.finish();
  if (!fresh) {
    await inspecting.promise;
    // Model a full retained page after its final. Full next-page history still fits.
    f.session().runtime.continuityBinding!.retainedPageTokens = 10_000_000;
    inspected.resolve();
  }
  await Promise.race([f.waitSubmission(2), queued.then(() => { throw new Error("Continuation ended before Send"); })]);
  const next = f.browserRuns[1]!;
  expect(next.key).not.toBe(f.browserRuns[0]!.key);
  const resultAt = next.prompt.indexOf("Verified repository state: clean.");
  const finalAt = next.prompt.indexOf("Completed with the appended instruction.");
  const inputAt = next.prompt.indexOf("Continue using the verified state.");
  expect(resultAt).toBeGreaterThan(-1);
  expect(finalAt).toBeGreaterThan(resultAt);
  expect(inputAt).toBeGreaterThan(finalAt);
  expect(next.prompt.split("Completed with the appended instruction.")).toHaveLength(2);
  expect(next.prompt).toContain(call!.id);
  await f.finish(); await queued; await resultObserver;
  expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(0);
  expect(queue.store.get(queue.identity)?.state).toBe("completed");
  expect(f.sends()).toBe(2);
});
