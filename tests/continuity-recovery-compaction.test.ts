import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ContinuityBindings, continuityCheckpoint, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, sameContinuityLauncherInstance, type ContinuityLease } from "../src/adapters/chatgpt-web/continuity-contract";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityRecoveryStore, continuityProcessInstance, continuityProcessStartIdentity } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { bindContinuityRequestScope, prepareContinuityRequest } from "../src/adapters/chatgpt-web/continuity-request";
import { admitHealthyRecoveryCompaction, assertHealthyRecoveryCompactionAuthority, beginHealthyRecoveryCompaction,
  commitRecoveryCompaction, failHealthyRecoveryCompaction, prepareRecoveryCompaction, recoveryCompactionTarget,
  selectRecoveryCompactionTarget, compileRecoveryCompactionInput } from "../src/adapters/chatgpt-web/continuity-recovery-compaction";
import { assertContinuityCompactionResult, runContinuityCompaction } from "../src/adapters/chatgpt-web/continuity-compaction";
import { cancelStructuredCompactionNativeTurn, canonicalizeCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import { chatGptBrowserTabClosedError } from "../src/adapters/chatgpt-web/adapter-error";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { chatGptContinuityInstructionPayloadDigest } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { acceptRecoveryResults, recoveryIdentity, recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import * as configModule from "../src/config";
import { OPENAI_ACCESS } from "../src/api-access";
import { startServer } from "../src/server";
import { leaveContinuityMode } from "../src/adapters/chatgpt-web/continuity-lifecycle";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { parseRequest } from "../src/responses/parser";
import { buildCompactV1Output, COMPACT_PROMPT, encodeCompactionSummary, extractCompactUserMessages } from "../src/responses/compaction";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const finish of cleanup.splice(0).reverse()) await finish(); });
const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };
const launcherRecovery = require("../launcher/electron/continuity-recovery.cjs");

function fixture(options: { manual?: boolean; delivered?: boolean; grouped?: boolean; sourceText?: string; sourceInstance?: boolean; threadId?: string } = {}) {
  // Keep Unix socket paths short; Windows uses the system temp directory.
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-recovery-compact-"));
  const state = join(directory, "continuity");
  const registrations = new ContinuityRegistrationStore(state);
  registrations.initialize();
  const bindings = new ContinuityBindings(registrations);
  const store = new ContinuityRecoveryStore(state);
  // Most tests isolate protocol behavior. The external process probe supplies an
  // OS-verified instance; sandbox-only tests use this explicit virtual host identity.
  const launcherInstance = { pid: process.pid, startIdentity: continuityProcessStartIdentity(process.pid)
    ?? "darwin:Sat Oct 10 00:00:00 2026", instanceId: "a".repeat(64) };
  const namespace = `fixture:${directory}`;
  const threadId = options.threadId ?? `thread:${directory}`;
  const thread = continuityDigest(threadId);
  const request = parseRequest({ model: options.manual ? CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL : "gpt-5.6-sol",
    reasoning: { effort: "low" }, instructions: "Preserve the actual current system instructions.",
    input: [...(options.grouped ? [
      { type: "message", role: "user", id: "previous-item", content: "Completed earlier history.",
        internal_chat_message_metadata_passthrough: { turn_id: "source-turn" } },
      { type: "message", role: "user", id: "accepted-constraint", content: "Keep the accepted current constraint.",
        internal_chat_message_metadata_passthrough: { turn_id: "source-turn" } },
    ] : []), { type: "message", role: "user", id: "source-item", content: options.sourceText ?? "Continue the accepted task after its interruption.",
      internal_chat_message_metadata_passthrough: { turn_id: "source-turn" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: "source-turn" }) },
  });
  request._conversationPolicy = "continuity-first";
  bindContinuityRequestScope(request, namespace);
  const scope = request._continuityScope!;
  const binding = bindings.create(thread, scope, "source-execution", continuityCheckpoint(request).digest, "source-turn");
  const sourceWorkId = "ordinary:source";
  const previous = options.grouped ? { instructionIdentity: "previous-item", nativeTurnId: "source-turn" } : undefined;
  if (previous) {
    const prior = structuredClone(request);
    (prior._rawBody as { input: unknown[] }).input.splice(1);
    store.admitWork({ thread, scope, owner: continuityProcessInstance(bindings.owner), logicalWorkId: "ordinary:previous",
      instructionIdentity: previous.instructionIdentity, nativeTurnId: previous.nativeTurnId,
      workPayloadDigest: chatGptContinuityInstructionPayloadDigest(prior), snapshotDigest: continuityDigest(prior.context),
      dispatchProtocolComplete: true });
    store.completeWork(thread, { scope }, "ordinary:previous", { receiptId: "previous-final", digest: continuityDigest("Completed earlier history.") });
  }
  let record = store.admitWork({ thread, scope, owner: continuityProcessInstance(bindings.owner), logicalWorkId: sourceWorkId,
    instructionIdentity: "source-item", nativeTurnId: "source-turn", workPayloadDigest: chatGptContinuityInstructionPayloadDigest(request, previous),
    ...(previous ? { instructionPrevious: previous } : {}),
    snapshotDigest: continuityDigest(request.context), dispatchProtocolComplete: true });
  record = store.markAttempt(thread, { scope, expectedVersion: record.version }, {
    logicalWorkId: sourceWorkId, attempt: 0, stage: "page-possible",
    ...(options.sourceInstance === false ? {} : { launcherInstance }) });
  binding.recovery = { directory: state, thread, logicalWorkId: sourceWorkId, attempt: 0 };
  if (options.delivered) {
    record = store.issueBatch(thread, { scope }, { logicalWorkId: sourceWorkId, attempt: 0,
      calls: [{ callId: "real-call", operationId: "real-operation", expectedResultType: "function_call_output" }] });
    record = store.markDeliveryPossible(thread, { scope }, ["real-call"]);
  }
  record = store.retireAttempt(thread, { scope }, sourceWorkId, 0);
  bindings.lose(binding);
  request._compactionRequest = true;
  const pages = new Map<string, { continuity: ContinuityLease; state: "running" | "ready" }>();
  let sends = 0;
  let inspectCalls = 0;
  let actualRetirement = false;
  const recoveryHost = { continuityLauncherInstance: launcherInstance, turnTabs: new Map() };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(incoming) {
    const path = new URL(incoming.url).pathname;
    if (path === "/v1/turn/continuity-capacity") return Response.json({ ok: true, available: true });
    if (path === "/v1/turn/continuity-send-possible") {
      const body = await incoming.json() as { recovery: import("../src/adapters/chatgpt-web/continuity-contract").ContinuityRecoveryIdentity };
      expect(store.get(thread)!.works[body.recovery.logicalWorkId]!.attempts[body.recovery.attempt]!.stage).toBe("send-possible");
      sends++;
      expect(sameContinuityLauncherInstance(body.recovery.launcherInstance, launcherInstance)).toBe(true);
      return Response.json({ ok: true, recovery: body.recovery, state: "send-possible", writerRetired: false,
        toolsSettled: false, sendAuthorized: true, launcherInstance, hostNoWriter: false });
    }
    if (path === "/v1/turn/continuity-retire") {
      const body = await incoming.json() as { recovery: unknown };
      if (actualRetirement) {
        try { return Response.json({ ok: true, ...await launcherRecovery.retireContinuityWriter(recoveryHost, body.recovery) }); }
        catch (error) { return Response.json({ ok: false, code: (error as { code?: string }).code }, { status: 409 }); }
      }
      return Response.json({ ok: true, recovery: body.recovery, state: "retired", writerRetired: true,
        toolsSettled: false, launcherInstance, hostNoWriter: true });
    }
    if (path === "/v1/turn/continuity-query") {
      const body = await incoming.json() as { recovery: unknown };
      return Response.json({ ok: true, ...launcherRecovery.queryContinuityTransaction(recoveryHost, body.recovery) });
    }
    inspectCalls++;
    const body = await incoming.json() as { conversationKey: string; expected: ContinuityLease };
    const page = pages.get(body.conversationKey);
    return page && JSON.stringify(body.expected) === JSON.stringify(page.continuity)
      ? Response.json({ ok: true, ...page }) : Response.json({ ok: false }, { status: 409 });
  } });
  const descriptor = join(directory, "launcher.json");
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development", pid: process.pid,
    launcherInstance,
    features: [CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE], endpoint: `http://127.0.0.1:${server.port}`,
    control: { endpoint: `http://127.0.0.1:${server.port}`, token: "a".repeat(43) },
    helper: { executable: process.execPath, script: import.meta.path }, partition: "persist:codex-web-gpt-dev-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: namespace,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: descriptor, brokerSocketPath: defaultBrokerEndpoint(directory),
      continuityStateDirectory: state, localToolsEnabled: true, solAvailable: true, proAvailable: false, extraHighAvailable: false,
      browserInteractionMode: options.manual ? "manual" : "automatic", toolAuthorityMode: "delegated" } };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const starts: BrowserTurn[] = [];
  const prompts: string[] = [];
  let failBeforeSend = false;
  let failSettlement = false;
  const run = spyOn(worker, "run").mockImplementation(async turn => {
    const physical = store.get(thread)!.works[turn.continuity!.recovery!.logicalWorkId]!.attempts.at(-1)!;
    expect(physical.stage).toBe("page-possible");
    expect(physical.launcherInstance).toEqual(launcherInstance);
    expect(turn.continuity!.recovery!.launcherInstance).toEqual(physical.launcherInstance);
    starts.push(turn);
    const compiled = await turn.prepare();
    prompts.push(compiled.text);
    expect(turn.nativeConnector).toBe(true);
    expect(turn.capabilities.localToolsEnabled).toBe(false);
    expect(compiled.text).not.toContain("turn_token turn_");
    expect(compiled.text).toContain("Continue the accepted task");
    expect(compiled.text).toContain("system instructions");
    if (failBeforeSend) { failBeforeSend = false; throw new Error("Injected prepare failure before Send"); }
    const lease: ContinuityLease = { owner: turn.continuity!.owner, leaseId: "1".repeat(32), traceId: turn.traceId,
      recovery: turn.continuity!.recovery };
    pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease?.(lease);
    await turn.onSendActivated?.();
    await turn.onSubmitted?.();
    const token = compiled.text.match(/turn_token (control_[A-Za-z0-9_-]+)/)![1]!;
    const handoffId = compiled.text.match(/handoff_id (handoff_[A-Za-z0-9_-]+)/)![1]!;
    await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, { method: "submit_compaction_handoff", token, handoffId,
      summary: "Checkpoint with the completed results and the unfinished instruction." });
    compiled.release();
    await new Promise<void>(resolve => {
      if (turn.abortSignal?.aborted) resolve(); else turn.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    pages.set(turn.conversationKey!, { continuity: lease, state: failSettlement ? "running" : "ready" });
    failSettlement = false;
    return "Checkpoint submitted";
  });
  cleanup.push(async () => { run.mockRestore(); await broker.close(); await server.stop(true); rmSync(directory, { recursive: true, force: true }); });
  const prepare = (parsed = request) => prepareRecoveryCompaction(parsed, provider, namespace, capabilities, worker, bindings,
    store.get(thread), descriptor);
  return { directory, state, bindings, binding, store, thread, threadId, scope, sourceWorkId, namespace, request, provider, worker, broker, starts,
    descriptor, launcherInstance,
    actualRetirement: () => { actualRetirement = true; },
    prepare, pages, prompts, sends: () => sends, inspectCalls: () => inspectCalls,
    failBeforeSend: () => { failBeforeSend = true; }, failSettlement: () => { failSettlement = true; } };
}

async function pausedCompaction(f: ReturnType<typeof fixture>, parsed: CodexParsedRequest) {
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const pending = spyOn(f.worker, "run").mockImplementation(async turn => {
    const compiled = await turn.prepare();
    f.starts.push(turn); f.prompts.push(compiled.text);
    const lease: ContinuityLease = { owner: turn.continuity!.owner, leaseId: "2".repeat(32), traceId: turn.traceId,
      recovery: turn.continuity!.recovery };
    f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease?.(lease);
    await turn.onSendActivated?.();
    await turn.onSubmitted?.();
    started();
    try {
      return await new Promise<string>((_resolve, reject) => {
        if (turn.abortSignal!.aborted) reject(turn.abortSignal!.reason);
        else turn.abortSignal!.addEventListener("abort", () => reject(turn.abortSignal!.reason), { once: true });
      });
    } finally { f.pages.set(turn.conversationKey!, { continuity: lease, state: "ready" }); }
  });
  cleanup.push(async () => { pending.mockRestore(); });
  const prepared = (await f.prepare(parsed))!;
  const observed = runContinuityCompaction(parsed, prepared, f.worker, f.broker, capabilities, f.namespace).catch(error => error);
  await start;
  return { prepared, observed };
}

async function interruptCompaction(f: ReturnType<typeof fixture>, turnId: string) {
  const configuration = { ...defaultConfig("browser-only"), port: 0 };
  const provider = spyOn(configModule, "providerConfig").mockReturnValue(f.provider);
  const server = startServer(configuration, { accessPolicy: OPENAI_ACCESS });
  cleanup.push(async () => { await server.stop(true); provider.mockRestore(); });
  return fetch(`http://127.0.0.1:${server.port}/admin/interrupt-turn`, { method: "POST",
    headers: { authorization: `Bearer ${configuration.controlToken}`, "content-type": "application/json" },
    body: JSON.stringify({ threadId: f.threadId, turnId }) });
}

test("Automatic lost compaction creates one tool-free page, commits, and replays after page loss", async () => {
  const f = fixture();
  const prepared = (await f.prepare())!;
  let recoveries = 0;
  const summary = await runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace,
    undefined, undefined, () => { recoveries++; });
  await assertContinuityCompactionResult(prepared);
  expect(f.starts).toHaveLength(1);
  expect(f.sends()).toBe(1);
  expect(recoveries).toBe(1);
  const record = f.store.get(f.thread)!;
  expect(record.epoch).toBe(1);
  expect(record.historyRevision).toBe(1);
  const checkpoint = Object.values(record.checkpoints)[0]!;
  expect(checkpoint.continuation.state).toBe("available");
  expect(checkpoint.coveredCallIds).toEqual([]);
  expect(f.bindings.observed(f.thread)!.lease?.leaseId).toBe("1".repeat(32));
  f.pages.clear();
  const inspections = f.inspectCalls();
  const wrapped = structuredClone(f.request);
  (wrapped._rawBody as { stream?: boolean }).stream = true;
  const replay = (await f.prepare(wrapped))!;
  expect(await runContinuityCompaction(wrapped, replay, f.worker, f.broker, capabilities, f.namespace,
    undefined, undefined, () => { recoveries++; })).toBe(summary);
  await assertContinuityCompactionResult(replay);
  expect(f.starts).toHaveLength(1);
  expect(recoveries).toBe(1);
  expect(f.inspectCalls()).toBe(inspections);
  expect(f.store.get(f.thread)!.historyRevision).toBe(1);
  const disk = readFileSync(join(f.state, "recovery.json"), "utf8");
  expect(disk).not.toContain("Checkpoint with the completed results");
  expect(disk).not.toContain("control_");
});

test("delivered business call without a real result cannot use lost compaction as a bypass", async () => {
  const f = fixture({ delivered: true });
  await expect(f.prepare()).rejects.toMatchObject({ code: "continuity_execution_unsettled" });
  expect(f.starts).toHaveLength(0);
  expect(f.store.get(f.thread)!.historyRevision).toBe(0);
});

test("lost compaction accepts the actual first result and records durable call coverage", async () => {
  const f = fixture({ delivered: true });
  const result = { type: "function_call_output", call_id: "real-call", output: "Command session ID 42 remains available." };
  (f.request._rawBody as { input: unknown[] }).input.push(result);
  f.request.context.messages.push(...parseRequest({ model: f.request.modelId, input: [result] }).context.messages);
  const prepared = (await f.prepare())!;
  await runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace);
  const record = f.store.get(f.thread)!;
  expect(record.calls["real-call"]!.firstResultDigest).toBe(recoveryResultDigest(result));
  expect(Object.values(record.checkpoints)[0]!.coveredCallIds).toEqual(["real-call"]);
  expect(f.prompts[0]).toContain("session ID 42");
});

test("Zero Risk lost compaction keeps the ended-response manual handoff boundary", async () => {
  const f = fixture({ manual: true });
  await expect(f.prepare()).rejects.toMatchObject({ code: "continuity_manual_handoff_required" });
  expect(f.starts).toHaveLength(0);
});

test("a compaction request may name a new native turn while its accepted source is in an earlier turn", async () => {
  const f = fixture();
  const metadata = f.request._rawBody as { client_metadata: Record<string, string> };
  metadata.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: f.threadId, turn_id: "compaction-turn" });
  const prepared = (await f.prepare())!;
  await runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace);
  expect(f.starts).toHaveLength(1);
  expect(Object.values(f.store.get(f.thread)!.compactionTargets)[0]!.sourceLogicalWorkId).toBe(f.sourceWorkId);
});

test("a complete retained handoff commits once without creating a page or inventing a lease", async () => {
  const f = fixture();
  const summary = canonicalizeCompactionHandoff(f.request, "The existing valid handoff.");
  f.binding.acceptedHandoff = { key: "old-compaction", sourceRevision: 0, sourceExecutionKey: "source-execution",
    summary, bytes: Buffer.byteLength(summary), lease: { owner: f.bindings.owner, leaseId: "2".repeat(32), traceId: "old-handoff" } };
  const prepared = (await f.prepare())!;
  expect(await runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace)).toBe(summary);
  expect(f.starts).toHaveLength(0);
  expect(prepared.binding.lease).toBeUndefined();
  expect(prepared.binding.state).toBe("creating");
  expect(f.store.get(f.thread)!.historyRevision).toBe(1);
  expect(Object.values(f.store.get(f.thread)!.checkpoints)[0]!.continuation.state).toBe("available");
});

test("a completed durable compaction with no body rejects without generating another summary", async () => {
  const f = fixture();
  const prepared = (await f.prepare())!;
  await runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace);
  await Bun.sleep(0);
  const fresh = new ContinuityBindings(new ContinuityRegistrationStore(f.state));
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
  cleanup.push(async () => { clock.mockRestore(); });
  await expect(prepareRecoveryCompaction(f.request, f.provider, f.namespace, capabilities, f.worker, fresh,
    f.store.get(f.thread), prepared.descriptor)).rejects.toMatchObject({ code: "continuity_replay_unavailable" });
  expect(f.starts).toHaveLength(1);
});

test("the complete recovery envelope keeps large history instead of native compaction trimming", () => {
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: [
    { role: "assistant", content: `keep-first-history-${"abc ".repeat(29000)}` },
    { role: "user", content: "Original task" },
  ] });
  parsed._compactionRequest = true;
  const compiled = compileRecoveryCompactionInput(parsed, capabilities, { token: "control_placeholder", handoffId: "handoff_placeholder" });
  expect(compiled.text).toContain("keep-first-history");
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
});

test("concurrent lost compaction observers share the same target and submit once", async () => {
  const f = fixture();
  const other = structuredClone(f.request);
  const [first, second] = await Promise.all([f.prepare(), f.prepare(other)]);
  expect(first!.executionKey).toBe(second!.executionKey);
  const [one, two] = await Promise.all([
    runContinuityCompaction(f.request, first!, f.worker, f.broker, capabilities, f.namespace),
    runContinuityCompaction(other, second!, f.worker, f.broker, capabilities, f.namespace),
  ]);
  expect(one).toBe(two);
  expect(f.starts).toHaveLength(1);
  expect(Object.keys(f.store.get(f.thread)!.checkpoints)).toHaveLength(1);
});

test("a failure before Send retains the stable target, transaction, and durable retry budget", async () => {
  const f = fixture();
  f.failBeforeSend();
  const first = (await f.prepare())!;
  await expect(runContinuityCompaction(f.request, first, f.worker, f.broker, capabilities, f.namespace))
    .rejects.toMatchObject({ code: "continuity_source_unproven" });
  await Bun.sleep(0);
  const failed = f.store.get(f.thread)!;
  const targetId = Object.keys(failed.compactionTargets)[0]!;
  const transactionId = failed.transaction!.transactionId;
  expect(failed.historyRevision).toBe(0);
  expect(failed.works[`compaction:${targetId}`]!.attempts[0]!.writerRetired).toBe(true);
  const next = (await f.prepare())!;
  expect(next.executionKey).toBe(first.executionKey);
  await runContinuityCompaction(f.request, next, f.worker, f.broker, capabilities, f.namespace);
  const committed = f.store.get(f.thread)!;
  expect(committed.transaction!.transactionId).toBe(transactionId);
  expect(committed.works[`compaction:${targetId}`]!.attempts).toHaveLength(2);
  expect(committed.works[`compaction:${targetId}`]!.attempts[1]!.snapshotVersion).toBe(1);
  expect(committed.historyRevision).toBe(1);
  expect(f.starts).toHaveLength(2);
});

test("a changed result or instruction cannot reuse a completed compaction identity", async () => {
  const f = fixture({ delivered: true });
  const result = { type: "function_call_output", call_id: "real-call", output: "Actual result." };
  (f.request._rawBody as { input: unknown[] }).input.push(result);
  f.request.context.messages.push(...parseRequest({ model: f.request.modelId, input: [result] }).context.messages);
  const first = (await f.prepare())!;
  await runContinuityCompaction(f.request, first, f.worker, f.broker, capabilities, f.namespace);
  const changedResult = structuredClone(f.request);
  ((changedResult._rawBody as { input: Array<Record<string, unknown>> }).input.at(-1)!).output = "Invented result.";
  await expect(f.prepare(changedResult)).rejects.toMatchObject({ code: "continuity_result_conflict" });
  const changedInstruction = structuredClone(f.request);
  (changedInstruction._rawBody as { input: Array<Record<string, unknown>> }).input[0]!.content = "Different current instruction.";
  await expect(f.prepare(changedInstruction)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.starts).toHaveLength(1);
});

test("durable grouped source selection preserves every accepted current instruction across page loss and replay", async () => {
  const f = fixture({ grouped: true });
  const prepared = (await f.prepare())!;
  const summary = await runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace);
  expect(f.prompts[0]).toContain("Keep the accepted current constraint.");
  f.pages.clear();
  const changed = structuredClone(f.request);
  (changed._rawBody as { input: Array<Record<string, unknown>> }).input[1]!.content = "Discard the accepted current constraint.";
  await expect(f.prepare(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const historical = structuredClone(f.request);
  (historical._rawBody as { input: Array<Record<string, unknown>> }).input[0]!.content = "A different completed historical display.";
  const replay = (await f.prepare(historical))!;
  expect(await runContinuityCompaction(historical, replay, f.worker, f.broker, capabilities, f.namespace)).toBe(summary);
  expect(f.starts).toHaveLength(1);
  const disk = readFileSync(join(f.state, "recovery.json"), "utf8");
  expect(disk).not.toContain("Keep the accepted current constraint.");
  expect(f.store.get(f.thread)!.works[f.sourceWorkId]!.instructionPrevious).toEqual({
    instructionIdentity: "previous-item", nativeTurnId: "source-turn",
  });
});

test("the producer's bounded v1 source representation replays the committed target without weakening its full source group", async () => {
  const f = fixture({ sourceText: `Continue the accepted task after its interruption. ${"Current source detail. ".repeat(4000)}` });
  const prepared = (await f.prepare())!;
  const summary = await runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace);
  const wrapped = structuredClone(f.request);
  const original = (wrapped._rawBody as { input: unknown[] }).input;
  (wrapped._rawBody as { input: unknown[] }).input = buildCompactV1Output(extractCompactUserMessages(original), summary).slice(0, -1);
  expect(JSON.stringify((wrapped._rawBody as { input: unknown[] }).input).length).toBeLessThan(JSON.stringify(original).length);
  const replay = (await f.prepare(wrapped))!;
  expect(await runContinuityCompaction(wrapped, replay, f.worker, f.broker, capabilities, f.namespace)).toBe(summary);
  expect(f.starts).toHaveLength(1);
});

test("a changed local compact prompt cannot replay an accepted compaction control", async () => {
  const f = fixture();
  f.request._compactionOutput = "message";
  const control = { role: "user" as const, content: "Summarize the current accepted results." };
  (f.request._rawBody as { input: unknown[] }).input.push(control);
  f.request.context.messages.push(...parseRequest({ model: f.request.modelId, input: [control] }).context.messages);
  const first = (await f.prepare())!;
  await runContinuityCompaction(f.request, first, f.worker, f.broker, capabilities, f.namespace);
  const changed = structuredClone(f.request);
  changed.context.messages.at(-1)!.content = "Summarize only the last result and discard the current task.";
  await expect(f.prepare(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.starts).toHaveLength(1);
});

test("a compaction transaction acquired after the deadline is revoked without opening a page", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const begin = f.broker.beginCompactionTransaction.bind(f.broker);
  let token: string | undefined;
  const delayed = spyOn(f.broker, "beginCompactionTransaction").mockImplementation(async (trace, timeout) => {
    await gate;
    const transaction = await begin(trace, timeout);
    token = transaction.token;
    return transaction;
  });
  const revoke = spyOn(f.broker, "abortCompactionTransaction");
  cleanup.push(async () => { delayed.mockRestore(); revoke.mockRestore(); });
  const first = (await f.prepare())!;
  await expect(runContinuityCompaction(f.request, first, f.worker, f.broker, capabilities, f.namespace, 5))
    .rejects.toMatchObject({ code: "continuity_session_lost" });
  release();
  await Bun.sleep(30);
  expect(token).toBeDefined();
  expect(revoke).toHaveBeenCalledWith(token!);
  expect(f.starts).toHaveLength(0);
  expect(f.store.get(f.thread)!.historyRevision).toBe(0);
});

test("identical summary text does not collapse different history targets", async () => {
  const f = fixture();
  const first = (await f.prepare())!;
  const summary = await runContinuityCompaction(f.request, first, f.worker, f.broker, capabilities, f.namespace);
  const prior = f.store.get(f.thread)!;
  const original = Object.values(prior.compactionTargets)[0]!;
  f.store.registerCompactionTarget(f.thread, { scope: f.scope }, {
    sourceLogicalWorkId: f.sourceWorkId, sourceIdentity: original.sourceIdentity,
    sourceHistoryRevision: 1, sourceToolBatchHeadSequence: 0, representationDigests: original.representationDigests,
  });
  const second = structuredClone(f.request);
  (second._rawBody as { input: unknown[] }).input.unshift({ type: "compaction", encrypted_content: encodeCompactionSummary(summary) });
  const selected = selectRecoveryCompactionTarget(second, f.store.get(f.thread)!);
  expect(selected!.target.sourceHistoryRevision).toBe(1);
  expect(selected!.target.compactionTargetId).not.toBe(original.compactionTargetId);
  expect(selected!.checkpoint).toBeUndefined();
  expect(selectRecoveryCompactionTarget(f.request, f.store.get(f.thread)!)!.target.compactionTargetId).toBe(original.compactionTargetId);
});

test("explicitly stopping recovered compaction persists the stopped identity before a retry", async () => {
  const f = fixture();
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const pending = spyOn(f.worker, "run").mockImplementation(async turn => {
    await turn.prepare();
    started();
    return new Promise<string>((_resolve, reject) => turn.abortSignal!.addEventListener("abort", () => reject(turn.abortSignal!.reason), { once: true }));
  });
  cleanup.push(async () => { pending.mockRestore(); });
  const prepared = (await f.prepare())!;
  const running = runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace);
  const observed = running.catch(error => error);
  await start;
  const identity = extractChatGptTurnIdentity(f.request);
  const cancelled = cancelStructuredCompactionNativeTurn(identity.threadId!, identity.turnId!, chatGptBrowserTabClosedError());
  expect(cancelled.cancelled).toBe(1);
  expect(await observed).toMatchObject({ code: "client_cancelled" });
  await cancelled.settlement;
  const record = f.store.get(f.thread)!;
  expect(record.state).toBe("stopped");
  expect(record.works[record.currentWorkId!]!.state).toBe("stopped");
  await expect(f.prepare()).rejects.toMatchObject({ code: "continuity_stopped" });
  expect(record.historyRevision).toBe(0);
});

for (const completedSource of [false, true]) test(`authenticated interrupt stops an independent compaction turn with completed source=${completedSource}`, async () => {
  const f = fixture({ threadId: `thread_compaction_stop_${continuityDigest(String(Math.random())).slice(0, 12)}` });
  if (completedSource) f.store.completeWork(f.thread, { scope: f.scope }, f.sourceWorkId,
    { receiptId: "source-final", digest: continuityDigest("The accepted source final") });
  const raw = structuredClone(f.request._rawBody) as { client_metadata: Record<string, string> };
  raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: f.threadId, turn_id: "compaction-turn" });
  const request = parseRequest(raw);
  request._conversationPolicy = "continuity-first"; request._compactionRequest = true;
  bindContinuityRequestScope(request, f.namespace);
  const running = await pausedCompaction(f, request);
  const response = await interruptCompaction(f, "compaction-turn");
  expect(response.status).toBe(200);
  expect(await running.observed).toMatchObject({ code: "continuity_stopped" });
  const stopped = new ContinuityRecoveryStore(f.state).get(f.thread)!;
  const compact = Object.values(stopped.works).find(work => work.purpose === "compaction")!;
  expect(compact).toMatchObject({ nativeTurnId: "compaction-turn", state: "stopped", stopReason: "native-interrupt" });
  expect(stopped.works[f.sourceWorkId]!.state).toBe(completedSource ? "completed" : "stopped");
  if (completedSource) expect(stopped.works[f.sourceWorkId]!.terminalReceiptId).toBe("source-final");
  expect(stopped.historyRevision).toBe(0);
  const reopened = new ContinuityBindings(new ContinuityRegistrationStore(f.state));
  await expect(prepareRecoveryCompaction(structuredClone(request), f.provider, f.namespace, capabilities, f.worker,
    reopened, stopped, f.descriptor)).rejects.toMatchObject({ code: "continuity_stopped" });
  const bootstrapPath = join(f.directory, "stopped-compaction-bootstrap.json");
  writeFileSync(bootstrapPath, JSON.stringify({ raw, provider: f.provider, namespace: f.namespace, state: f.state,
    thread: f.thread, descriptor: f.descriptor, capabilities }));
  const sends = f.sends();
  const child = Bun.spawn([process.execPath, "-e", `
    import { readFileSync } from "node:fs";
    import { parseRequest } from "./src/responses/parser";
    import { ChatGptBrowserWorker } from "./src/adapters/chatgpt-web/browser-worker";
    import { ContinuityBindings } from "./src/adapters/chatgpt-web/continuity-binding";
    import { ContinuityRegistrationStore } from "./src/adapters/chatgpt-web/continuity-registration";
    import { ContinuityRecoveryStore } from "./src/adapters/chatgpt-web/continuity-recovery-store";
    import { bindContinuityRequestScope } from "./src/adapters/chatgpt-web/continuity-request";
    import { prepareRecoveryCompaction } from "./src/adapters/chatgpt-web/continuity-recovery-compaction";
    const input = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const parsed = parseRequest(input.raw);
    parsed._conversationPolicy = "continuity-first"; parsed._compactionRequest = true;
    bindContinuityRequestScope(parsed, input.namespace);
    try {
      await prepareRecoveryCompaction(parsed, input.provider, input.namespace, input.capabilities,
        ChatGptBrowserWorker.forProvider(input.provider), new ContinuityBindings(new ContinuityRegistrationStore(input.state)),
        new ContinuityRecoveryStore(input.state).get(input.thread), input.descriptor);
      process.exit(71);
    } catch (error) {
      if (error.code !== "continuity_stopped") throw error;
      process.stdout.write(error.code);
    }
  `, bootstrapPath], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const childOutput = await new Response(child.stdout).text();
  const childError = await new Response(child.stderr).text();
  expect(await child.exited, childError).toBe(0);
  expect(childOutput).toBe("continuity_stopped");
  expect(f.sends()).toBe(sends);
  expect(f.starts).toHaveLength(1);
  const compatible = spyOn(f.worker, "assertContinuityCompatible").mockResolvedValue();
  cleanup.push(async () => { compatible.mockRestore(); });
  const fresh = parseRequest({ model: request.modelId, reasoning: { effort: "low" }, instructions: "Preserve the actual current system instructions.",
    input: [{ type: "message", role: "user", id: "new-C", content: "New explicit work after the stopped compaction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-C" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-C" }) } });
  fresh._conversationPolicy = "continuity-first";
  const next = await prepareContinuityRequest(fresh, f.provider, f.namespace, capabilities, f.worker);
  expect(next.binding.epoch).toBe(stopped.epoch + 1);
  const retry = await prepareContinuityRequest(structuredClone(fresh), f.provider, f.namespace, capabilities, f.worker);
  expect(retry.binding.epoch).toBe(next.binding.epoch);
  expect(new ContinuityRecoveryStore(f.state).get(f.thread)!.epoch).toBe(stopped.epoch + 1);
  expect(f.starts).toHaveLength(1);
});

test("durable-only mode exit stops active and shadow compaction while preserving a completed source", async () => {
  for (const active of [false, true]) {
    const f = fixture();
    f.store.completeWork(f.thread, { scope: f.scope }, f.sourceWorkId,
      { receiptId: "source-final", digest: continuityDigest("The actual source answer") });
    let running: Awaited<ReturnType<typeof pausedCompaction>> | undefined;
    let workId: string;
    if (active) {
      running = await pausedCompaction(f, f.request);
      workId = f.store.get(f.thread)!.currentWorkId!;
    } else {
      const prepared = (await f.prepare())!;
      workId = beginHealthyRecoveryCompaction(f.request, prepared)!;
      expect(f.store.get(f.thread)!.currentWorkId).toBe(f.sourceWorkId);
    }
    await leaveContinuityMode(f.state, f.threadId);
    const record = new ContinuityRecoveryStore(f.state).get(f.thread)!;
    expect(record.works[f.sourceWorkId]).toMatchObject({ state: "completed", terminalReceiptId: "source-final" });
    expect(record.works[workId]).toMatchObject({ state: "stopped", stopReason: "mode-exit" });
    expect(record.historyRevision).toBe(0);
    if (running) {
      const identity = extractChatGptTurnIdentity(f.request);
      const cancelled = cancelStructuredCompactionNativeTurn(identity.threadId!, identity.turnId!,
        new DOMException("The route changed after durable mode exit", "AbortError"));
      expect(await running.observed).toMatchObject({ code: "continuity_stopped" });
      await cancelled.settlement;
    }
    await expect(f.prepare()).rejects.toMatchObject({ code: "continuity_stopped" });
  }
});

test("authenticated stop preserves a committed compaction for read-only replay", async () => {
  const f = fixture({ threadId: `thread_checkpoint_stop_${continuityDigest(String(Math.random())).slice(0, 12)}` });
  const prepared = (await f.prepare())!;
  const summary = await runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace);
  const checkpoint = Object.values(f.store.get(f.thread)!.checkpoints)[0]!;
  const sends = f.sends();
  const response = await interruptCompaction(f, "source-turn");
  expect(response.status).toBe(200);
  f.pages.clear();
  const replay = (await f.prepare())!;
  expect(await runContinuityCompaction(f.request, replay, f.worker, f.broker, capabilities, f.namespace)).toBe(summary);
  expect(f.store.get(f.thread)!.checkpoints[checkpoint.commitId]).toEqual(checkpoint);
  expect(f.store.get(f.thread)!.historyRevision).toBe(1);
  expect(f.sends()).toBe(sends);
  expect(f.starts).toHaveLength(1);
});

test("an AbortError without authenticated durable stop does not create a stopped compaction", async () => {
  const f = fixture();
  const detached = spyOn(f.worker, "run").mockImplementation(async turn => {
    await turn.prepare();
    throw new DOMException("A nonterminal observer or connection was detached", "AbortError");
  });
  cleanup.push(async () => { detached.mockRestore(); });
  const prepared = (await f.prepare())!;
  await expect(runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace))
    .rejects.toMatchObject({ code: "continuity_source_unproven" });
  const record = f.store.get(f.thread)!;
  expect(record.state).toBe("lost");
  expect(Object.values(record.works).some(work => work.state === "stopped" || work.stopReason !== undefined)).toBe(false);
  expect(record.historyRevision).toBe(0);
});

test("an obsolete snapshot callback cannot retire or fail the newer prepared compaction", async () => {
  const f = fixture();
  let latestSnapshot = -1;
  const stale = spyOn(f.worker, "run").mockImplementation(async turn => {
    await turn.prepare();
    const identity = turn.continuity!.recovery!;
    const record = f.store.get(f.thread)!;
    const rebound = f.store.rebindSnapshot(f.thread, { scope: f.scope, expectedVersion: record.version },
      identity.logicalWorkId, continuityDigest("The newer prepared snapshot"));
    latestSnapshot = rebound.works[identity.logicalWorkId]!.attempts.at(-1)!.snapshotVersion;
    await turn.onSendActivated!();
    return "An obsolete writer must never reach this return";
  });
  cleanup.push(async () => { stale.mockRestore(); });
  const prepared = (await f.prepare())!;
  await expect(runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace))
    .rejects.toMatchObject({ code: "continuity_source_unproven" });
  const record = f.store.get(f.thread)!;
  const work = record.works[record.currentWorkId!]!;
  expect(work.attempts.at(-1)).toMatchObject({ snapshotVersion: latestSnapshot, stage: "prepared", writerRetired: false });
  expect(work.retryBudget?.lastFailureAt).toBeUndefined();
  expect(record.historyRevision).toBe(0);
  expect(prepared.binding.state).toBe("creating");
  expect(f.sends()).toBe(0);
});

test("a healthy control observer cannot adopt or commit a newer snapshot of the same attempt", async () => {
  const f = fixture();
  const prepared = (await f.prepare())!;
  const workId = beginHealthyRecoveryCompaction(f.request, prepared)!;
  expect(f.store.get(f.thread)!.currentWorkId).toBe(f.sourceWorkId);
  expect(admitHealthyRecoveryCompaction(f.request, prepared)).toBe(workId);
  const record = f.store.get(f.thread)!;
  f.store.rebindSnapshot(f.thread, { scope: f.scope, expectedVersion: record.version }, workId,
    continuityDigest("A new accepted preparation must keep its own writer"));
  expect(() => assertHealthyRecoveryCompactionAuthority(prepared)).toThrow();
  expect(() => admitHealthyRecoveryCompaction(f.request, prepared)).toThrow();
  expect(() => commitRecoveryCompaction(f.request, prepared, recoveryCompactionTarget(f.request)!, workId,
    "The old observer's summary", false)).toThrow();
  await failHealthyRecoveryCompaction(f.request, prepared);
  const after = f.store.get(f.thread)!;
  expect(after.historyRevision).toBe(0);
  expect(after.works[workId]!.attempts.at(-1)).toMatchObject({ snapshotVersion: 1, stage: "prepared", writerRetired: false });
  expect(after.works[workId]!.retryBudget?.lastFailureAt).toBeUndefined();
  expect(after.works[workId]!.retryBudget?.attempts).toBe(1);
  expect(f.starts).toHaveLength(0);
});

test("healthy control preserves the source Launcher instance and refuses missing or changed instance proof", async () => {
  const f = fixture();
  const prepared = (await f.prepare())!;
  const workId = beginHealthyRecoveryCompaction(f.request, prepared)!;
  expect(f.store.get(f.thread)!.works[workId]!.attempts.at(-1)!.launcherInstance).toEqual(f.launcherInstance);
  expect(f.store.get(f.thread)!.currentWorkId).toBe(f.sourceWorkId);
  const missing = fixture({ sourceInstance: false });
  const missingPrepared = (await missing.prepare())!;
  expect(() => beginHealthyRecoveryCompaction(missing.request, missingPrepared)).toThrow();
  expect(Object.values(missing.store.get(missing.thread)!.works).filter(work => work.purpose === "compaction")).toHaveLength(0);
  const changed = fixture();
  const changedPrepared = (await changed.prepare())!;
  const descriptor = JSON.parse(readFileSync(changed.descriptor, "utf8"));
  descriptor.launcherInstance.instanceId = "b".repeat(64);
  writeFileSync(changed.descriptor, JSON.stringify(descriptor));
  expect(() => beginHealthyRecoveryCompaction(changed.request, changedPrepared)).toThrow();
  expect(Object.values(changed.store.get(changed.thread)!.works).filter(work => work.purpose === "compaction")).toHaveLength(0);
  expect(changed.starts).toHaveLength(0);
});

test("a recovery-v2 host cannot acquire a new compaction page", async () => {
  const f = fixture();
  const prepared = (await f.prepare())!;
  const descriptor = JSON.parse(readFileSync(f.descriptor, "utf8"));
  descriptor.features = [CONTINUITY_FEATURE, "session-continuity-recovery-v2"];
  delete descriptor.launcherInstance;
  writeFileSync(f.descriptor, JSON.stringify(descriptor));
  await expect(runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace))
    .rejects.toMatchObject({ code: "continuity_configuration_conflict" });
  expect(f.starts).toHaveLength(0);
  expect(f.sends()).toBe(0);
  expect(f.store.get(f.thread)!.historyRevision).toBe(0);
});

test("a missing receipt cannot retire an unproved old Launcher instance for compaction", async () => {
  const f = fixture();
  await f.prepare();
  const record = f.store.get(f.thread)!;
  const target = Object.values(record.compactionTargets)[0]!;
  const workId = `compaction:${target.compactionTargetId}`;
  const inputDigest = continuityDigest({ compactionTargetId: target.compactionTargetId, control: COMPACT_PROMPT });
  let admitted = f.store.admitWork({ thread: f.thread, scope: f.scope, owner: continuityProcessInstance(f.bindings.owner),
    logicalWorkId: workId, instructionIdentity: workId, nativeTurnId: "source-turn", workPayloadDigest: inputDigest,
    snapshotDigest: inputDigest, purpose: "compaction", compactionTargetId: target.compactionTargetId,
    createPage: true, dispatchProtocolComplete: true });
  admitted = f.store.markAttempt(f.thread, { scope: f.scope, expectedVersion: admitted.version }, {
    logicalWorkId: workId, attempt: 0, stage: "page-possible",
    launcherInstance: { ...f.launcherInstance, instanceId: "d".repeat(64) } });
  f.store.markAttempt(f.thread, { scope: f.scope, expectedVersion: admitted.version }, {
    logicalWorkId: workId, attempt: 0, stage: "send-possible" });
  f.actualRetirement();
  const receipt = launcherRecovery.queryContinuityTransaction({ continuityLauncherInstance: f.launcherInstance, turnTabs: new Map() },
    recoveryIdentity(f.store.get(f.thread)!, f.store.installationId()));
  expect(receipt).toMatchObject({ hostNoWriter: true, writerRetired: false });
  await expect(f.prepare()).rejects.toMatchObject({ code: "continuity_execution_unsettled" });
  expect(f.store.get(f.thread)!.works[workId]!.attempts.at(-1)!.writerRetired).toBe(false);
  expect(f.starts).toHaveLength(0);
  expect(f.sends()).toBe(0);
  expect(f.store.get(f.thread)!.historyRevision).toBe(0);
});

test("checkpoint capacity retry releases optional bodies after preserving the required local result", async () => {
  const f = fixture({ delivered: true });
  const result = { type: "function_call_output", call_id: "real-call", output: "The real locally retained result required by this compaction." };
  acceptRecoveryResults({ directory: f.state, thread: f.thread, logicalWorkId: f.sourceWorkId, attempt: 0 }, [result]);
  expect(f.store.get(f.thread)!.calls["real-call"]!.resultBodyBytes).toBeGreaterThan(0);
  const register = ContinuityRecoveryStore.prototype.registerCompactionTarget;
  const blocked = spyOn(ContinuityRecoveryStore.prototype, "registerCompactionTarget").mockImplementationOnce(() => {
    throw Object.assign(new Error("Injected shared budget capacity"), { code: "continuity_resource_capacity" });
  }).mockImplementation(register);
  cleanup.push(async () => { blocked.mockRestore(); });
  const prepared = (await f.prepare())!;
  expect(f.store.get(f.thread)!.calls["real-call"]!.resultBodyBytes ?? 0).toBe(0);
  expect(prepared).toBeDefined();
  await runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace);
  expect(f.prompts[0]).toContain(result.output);
  expect(f.store.get(f.thread)!.historyRevision).toBe(1);
  expect(f.store.get(f.thread)!.calls["real-call"]!.firstResultDigest).toBe(recoveryResultDigest(result));
});

const processExitTest = continuityProcessStartIdentity(process.pid) ? test : test.skip;
processExitTest("a compaction with no Launcher receipt recovers once after the actual old component process exits", async () => {
  const f = fixture();
  await f.prepare();
  const target = Object.values(f.store.get(f.thread)!.compactionTargets)[0]!;
  const bootstrapPath = join(f.directory, "component-bootstrap.json");
  writeFileSync(bootstrapPath, JSON.stringify({ directory: f.state, thread: f.thread, target,
    payloadDigest: continuityDigest({ compactionTargetId: target.compactionTargetId, control: COMPACT_PROMPT }) }));
  const child = Bun.spawn([process.execPath, "-e", `
    import { readFileSync } from "node:fs";
    import { ContinuityRecoveryStore, continuityProcessInstance, continuityProcessStartIdentity } from "./src/adapters/chatgpt-web/continuity-recovery-store";
    const input = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const store = new ContinuityRecoveryStore(input.directory);
    const source = store.get(input.thread);
    const owner = continuityProcessInstance();
    if (owner.startIdentity === "unverified") process.exit(72);
    const logicalWorkId = "compaction:" + input.target.compactionTargetId;
    let record = store.admitWork({ thread: input.thread, scope: source.scope, owner, logicalWorkId,
      instructionIdentity: logicalWorkId, nativeTurnId: "source-turn", workPayloadDigest: input.payloadDigest,
      snapshotDigest: input.payloadDigest, purpose: "compaction", compactionTargetId: input.target.compactionTargetId,
      createPage: true, dispatchProtocolComplete: true });
    const launcherInstance = { pid: process.pid, startIdentity: continuityProcessStartIdentity(process.pid), instanceId: "c".repeat(64) };
    record = store.markAttempt(input.thread, { scope: record.scope, expectedVersion: record.version },
      { logicalWorkId, attempt: 0, stage: "page-possible", launcherInstance });
    store.markAttempt(input.thread, { scope: record.scope, expectedVersion: record.version },
      { logicalWorkId, attempt: 0, stage: "send-possible" });
    process.exit(0);
  `, bootstrapPath], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const childError = await new Response(child.stderr).text();
  expect(await child.exited, childError).toBe(0);
  const old = f.store.get(f.thread)!;
  const oldIdentity = recoveryIdentity(old, f.store.installationId());
  const emptyHost = { continuityLauncherInstance: f.launcherInstance, turnTabs: new Map() };
  const receipt = launcherRecovery.queryContinuityTransaction(emptyHost, oldIdentity);
  expect(receipt).toMatchObject({ state: "missing", writerRetired: true, hostNoWriter: true });
  expect(receipt.launcherInstance).toEqual(f.launcherInstance);
  f.actualRetirement();
  const prepared = (await f.prepare())!;
  const summary = await runContinuityCompaction(f.request, prepared, f.worker, f.broker, capabilities, f.namespace);
  expect(summary).toContain("Checkpoint with the completed results");
  expect(f.starts).toHaveLength(1);
  expect(f.sends()).toBe(1);
  const current = f.store.get(f.thread)!;
  expect(current.works[current.currentWorkId!]!.attempts).toHaveLength(2);
  expect(current.historyRevision).toBe(1);
  expect(current.transaction!.launcherInstance).toEqual(f.launcherInstance);
  const replay = (await f.prepare())!;
  expect(await runContinuityCompaction(f.request, replay, f.worker, f.broker, capabilities, f.namespace)).toBe(summary);
  expect(f.sends()).toBe(1);
});

test("standalone compaction cannot activate a new continuity thread", async () => {
  const f = fixture();
  await expect(prepareRecoveryCompaction(f.request, f.provider, f.namespace, capabilities, f.worker,
    f.bindings, undefined, f.provider.chatgptWeb!.browserHostDescriptorPath!)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.starts).toHaveLength(0);
});

test("an accepted full handoff survives a failed settlement and is committed without a second summary", async () => {
  const f = fixture();
  f.failSettlement();
  const first = (await f.prepare())!;
  await expect(runContinuityCompaction(f.request, first, f.worker, f.broker, capabilities, f.namespace)).rejects.toMatchObject({ code: "continuity_session_lost" });
  await Bun.sleep(0);
  expect(f.store.get(f.thread)!.historyRevision).toBe(0);
  expect(first.binding.acceptedHandoff?.summary).toContain("Checkpoint with the completed results");
  const retry = (await f.prepare())!;
  const result = await runContinuityCompaction(f.request, retry, f.worker, f.broker, capabilities, f.namespace);
  expect(result).toContain("Checkpoint with the completed results");
  expect(f.starts).toHaveLength(1);
  expect(f.sends()).toBe(1);
  expect(retry.binding.lease).toBeUndefined();
  expect(f.store.get(f.thread)!.historyRevision).toBe(1);
});

test("a crash after durable commit cannot cause another summary when the result body is retained", async () => {
  const f = fixture();
  const install = f.bindings.installRecoveryCheckpoint.bind(f.bindings);
  const crash = spyOn(f.bindings, "installRecoveryCheckpoint").mockImplementationOnce(() => { throw new Error("Injected local publication failure after durable commit"); })
    .mockImplementation(install);
  cleanup.push(async () => { crash.mockRestore(); });
  const first = (await f.prepare())!;
  await expect(runContinuityCompaction(f.request, first, f.worker, f.broker, capabilities, f.namespace))
    .rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.store.get(f.thread)!.historyRevision).toBe(1);
  const replay = (await f.prepare())!;
  expect(await runContinuityCompaction(f.request, replay, f.worker, f.broker, capabilities, f.namespace)).toContain("Checkpoint with the completed results");
  expect(replay.binding.revision).toBe(1);
  expect(replay.binding.checkpoints.has(replay.executionKey)).toBe(true);
  expect(f.starts).toHaveLength(1);
  expect(f.store.get(f.thread)!.historyRevision).toBe(1);
});

test("checkpoint-only admission and a stop retry retain one durable consumer after losing the original body", async () => {
  const f = fixture();
  const compact = (await f.prepare())!;
  const summary = await runContinuityCompaction(f.request, compact, f.worker, f.broker, capabilities, f.namespace);
  const compatible = spyOn(f.worker, "assertContinuityCompatible").mockResolvedValue();
  cleanup.push(async () => { compatible.mockRestore(); });
  const continuation = parseRequest({ model: f.request.modelId, reasoning: { effort: "low" },
    instructions: "Preserve the actual current system instructions.",
    input: [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary) }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "source-turn" }) },
  });
  continuation._conversationPolicy = "continuity-first";
  const first = await prepareContinuityRequest(continuation, f.provider, f.namespace, capabilities, f.worker);
  const record = f.store.get(f.thread)!;
  const checkpoint = Object.values(record.checkpoints)[0]!;
  expect(checkpoint.continuation.state).toBe("consumed");
  const consumer = checkpoint.continuation.consumerLogicalWorkId!;
  expect(first.binding.recovery!.logicalWorkId).toBe(consumer);
  expect(first.input!.context.messages.some(message => message.role === "user" && typeof message.content === "string"
    && message.content.includes("Checkpoint with the completed results"))).toBe(true);
  f.store.stopWork(f.thread, { scope: f.scope }, consumer, "user-stop");
  const retry = structuredClone(continuation);
  await expect(prepareContinuityRequest(retry, f.provider, f.namespace, capabilities, f.worker)).rejects.toMatchObject({ code: "continuity_stopped" });
  expect(Object.values(f.store.get(f.thread)!.checkpoints)[0]!.continuation.consumerLogicalWorkId).toBe(consumer);
  expect(f.starts).toHaveLength(1);
});

test("checkpoint-only retry before Send reserves the next attempt for its already consumed work", async () => {
  const f = fixture();
  const compact = (await f.prepare())!;
  const summary = await runContinuityCompaction(f.request, compact, f.worker, f.broker, capabilities, f.namespace);
  const compatible = spyOn(f.worker, "assertContinuityCompatible").mockResolvedValue();
  cleanup.push(async () => { compatible.mockRestore(); });
  const continuation = parseRequest({ model: f.request.modelId, reasoning: { effort: "low" },
    instructions: "Preserve the actual current system instructions.",
    input: [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary) }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "source-turn" }) },
  });
  continuation._conversationPolicy = "continuity-first";
  const first = await prepareContinuityRequest(continuation, f.provider, f.namespace, capabilities, f.worker);
  const consumer = first.binding.recovery!.logicalWorkId;
  f.store.retireAttempt(f.thread, { scope: f.scope }, consumer, 0);
  f.store.recordFailure(f.thread, { scope: f.scope }, consumer);
  const next = await prepareContinuityRequest(structuredClone(continuation), f.provider, f.namespace, capabilities, f.worker);
  expect(next.binding.recovery!.logicalWorkId).toBe(consumer);
  expect(next.binding.recovery!.attempt).toBe(1);
  const checkpoint = Object.values(f.store.get(f.thread)!.checkpoints)[0]!;
  expect(checkpoint.continuation).toMatchObject({ state: "consumed", consumerLogicalWorkId: consumer });
  expect(Object.values(f.store.get(f.thread)!.works).filter(work => work.purpose === "ordinary")).toHaveLength(2);
  expect(f.starts).toHaveLength(1);
});

for (const history of ["omitted", "edited"] as const) test(`a selected durable checkpoint covers ${history} old tool bodies when the next compaction uses a new page`, async () => {
  const f = fixture({ delivered: true });
  const result = { type: "function_call_output", call_id: "real-call", output: "The original actual result." };
  (f.request._rawBody as { input: unknown[] }).input.push(result);
  f.request.context.messages.push(...parseRequest({ model: f.request.modelId, input: [result] }).context.messages);
  const first = (await f.prepare())!;
  const summary = await runContinuityCompaction(f.request, first, f.worker, f.broker, capabilities, f.namespace);
  const original = Object.values(f.store.get(f.thread)!.compactionTargets)[0]!;
  const firstResultDigest = f.store.get(f.thread)!.calls["real-call"]!.firstResultDigest;
  f.store.registerCompactionTarget(f.thread, { scope: f.scope }, {
    sourceLogicalWorkId: f.sourceWorkId, sourceIdentity: original.sourceIdentity, sourceHistoryRevision: 1,
    sourceToolBatchHeadSequence: 1, representationDigests: original.representationDigests,
  });
  const requestBody = f.request._rawBody as { client_metadata: unknown; input: unknown[] };
  const next = parseRequest({ model: f.request.modelId, reasoning: { effort: "low" },
    instructions: "Preserve the actual current system instructions.",
    client_metadata: requestBody.client_metadata, input: [
      { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }, requestBody.input[0],
      ...(history === "edited" ? [{ ...result, output: "Edited trusted historical result." }] : []),
    ] });
  next._conversationPolicy = "continuity-first"; next._compactionRequest = true;
  bindContinuityRequestScope(next, f.namespace);
  const live = f.bindings.observed(f.thread)!;
  f.bindings.lose(live); f.pages.clear();
  const prepared = (await f.prepare(next))!;
  const nextSummary = await runContinuityCompaction(next, prepared, f.worker, f.broker, capabilities, f.namespace);
  expect(f.starts).toHaveLength(2);
  expect(f.prompts[1]).not.toContain("The original actual result.");
  expect(f.store.get(f.thread)!.historyRevision).toBe(2);
  const checkpoint = Object.values(f.store.get(f.thread)!.checkpoints).find(value => value.targetHistoryRevision === 2)!;
  expect(checkpoint.coveredCallIds).toEqual(["real-call"]);
  expect(f.store.get(f.thread)!.calls["real-call"]!.firstResultDigest).toBe(firstResultDigest);
  const committed = f.store.get(f.thread)!;
  const replay = (await f.prepare(structuredClone(next)))!;
  expect(await runContinuityCompaction(structuredClone(next), replay, f.worker, f.broker, capabilities, f.namespace)).toBe(nextSummary);
  expect(f.store.get(f.thread)).toEqual(committed);
  expect(f.starts).toHaveLength(2);
});
