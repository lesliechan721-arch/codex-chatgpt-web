import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint, defaultConfig, CHATGPT_CONNECTOR_NAME } from "../src/config";
import { responseRequest } from "../src/server";
import { buildResponseJSON } from "../src/bridge";
import { compactionBody } from "../scripts/validate-unified-task-continuity-transitions";
import { runContinuityHarnessRequest, summarizeHarnessResponse, type HarnessRequestOptions, type HarnessRequestSnapshot } from "../scripts/unified-task-continuity-request-retry";
import { redactContinuityEvidence } from "../scripts/validate-unified-task-continuity";
import { createChatGptWebAdapter } from "./helpers/chatgpt-web-adapter";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityRecoveryStore, continuityProcessInstance, type RecoveryThreadRecord } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { recoveryIdentity, recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import type { ContinuityClaim, ContinuityLease } from "../src/adapters/chatgpt-web/continuity-contract";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE } from "../src/adapters/chatgpt-web/continuity-contract";
import { CONTINUITY_EXECUTION_FENCING_FEATURE, LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";

type Row = Record<string, any>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { chatGptTurnSessions.clear(); for (const close of cleanups.splice(0).reverse()) await close(); });

/** Loopback HTTP Responses + production adapter/Broker/store; only physical worker/Launcher are controlled.
 * Derived from the independent ordinary06 public fixture. No browser, DEV or real Send. */
function publicLossFixture(successorFails = false) {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-retry8-")), statePath = join(root, "continuity");
  new ContinuityRegistrationStore(statePath).initialize();
  const processInstance = continuityProcessInstance();
  // The controlled Launcher uses a fixture identity when OS process probing is unavailable.
  const launcherInstance = { pid: process.pid, startIdentity: processInstance.startIdentity === "unverified"
    ? "darwin:Sat Oct 10 00:00:00 2026" : processInstance.startIdentity, instanceId: "a".repeat(64) };
  const pages = new Map<string, { continuity: ContinuityLease; state: "ready" | "running" }>();
  let sends = 0, dispatches = 0, browserRuns = 0;
  let successorRecord: RecoveryThreadRecord | undefined;
  const pageRecords: RecoveryThreadRecord[] = [], compiledTexts: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("capacity")) return Response.json({ ok: true, executionProtocol: 1, available: true });
    const body = await request.json() as Row;
    if (path.startsWith("/v1/turn/continuity-") && body.recovery) {
      const retired = path.endsWith("retire"), preparing = path.endsWith("prepare");
      if (retired) pages.clear();
      return Response.json({ ok: true, executionProtocol: 1, recovery: body.recovery, launcherInstance,
        ...(preparing ? { preparationExpected: body.expected } : {}), hostNoWriter: retired, state: retired ? "retired" : preparing ? "prepared" : "send-possible",
        writerRetired: retired, executionIsolated: retired, physicalCleanup: retired ? "destroyed" : "pending", toolsSettled: false, sendAuthorized: true });
    }
    const page = pages.get(body.conversationKey);
    const matches = page && JSON.stringify(page.continuity) === JSON.stringify(body.expected);
    if (path.endsWith("release")) { if (matches) pages.delete(body.conversationKey); return Response.json({ ok: true, released: matches ? 1 : 0 }); }
    return matches ? Response.json({ ok: true, ...page }) : Response.json({ ok: false, code: "continuity_session_lost" }, { status: 409 });
  } });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development", pid: process.pid, launcherInstance,
    features: [CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, CONTINUITY_EXECUTION_FENCING_FEATURE], endpoint: `http://127.0.0.1:${server.port}`,
    control: { endpoint: `http://127.0.0.1:${server.port}`, token: "a".repeat(43) }, helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-dev-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString() }), { mode: 0o600 });
  // The controlled worker reads the existing inline protocol. Default short startup
  // and required-text delivery have separate production MCP integration tests.
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `fixture://${root}`, chatgptWeb: { maxComposerCodePoints: 2_000_000,
    browserHost: "launcher", browserInteractionMode: "automatic", browserHostDescriptorPath: descriptorPath, appName: CHATGPT_CONNECTOR_NAME,
    brokerSocketPath: defaultBrokerEndpoint(root), continuityStateDirectory: statePath, localToolsEnabled: true, solAvailable: true,
    toolAuthorityMode: "delegated", proAvailable: false, extraHighAvailable: false } };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!), worker = ChatGptBrowserWorker.forProvider(provider);
  const compatible = spyOn(worker, "assertContinuityCompatible").mockResolvedValue();
  const updates = spyOn(worker, "supportsTaskUpdates").mockResolvedValue(true);
  const run = spyOn(worker, "run").mockImplementation(async (turn: BrowserTurn) => {
    browserRuns++;
    const claim = turn.continuity as ContinuityClaim;
    const lease: ContinuityLease = { owner: claim.owner, leaseId: "1".repeat(32), traceId: turn.traceId, recovery: claim.recovery };
    pages.set(turn.conversationKey!, { continuity: lease, state: "running" }); turn.onContinuityLease!(lease);
    pageRecords.push(store.get(thread)!);
    if (browserRuns > 1) successorRecord = store.get(thread);
    const compiled = await turn.prepare(); if (compiled.contextPlan) await turn.onContextPlanSelected!(compiled.contextPlan.planId);
    compiledTexts.push(compiled.text);
    await turn.onSendActivated?.(); sends++; await turn.onSubmitted?.();
    if (browserRuns === 1) {
      const token = compiled.text.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)![1]!;
      await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token });
      const result = callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, { method: "native_operation_start", token, contract: "native",
        nativeWaitProtocol: 1, taskUpdateProtocol: 1, taskRevision: 0, operationId: 1, entry: "codex_exec",
        nativeInput: { cmd: "inert-synthetic-fixture-not-executed" } }, null);
      void result.catch(() => {});
      let progress = turn.externalProgress!.snapshot();
      while (progress.lastToolBatchRevision === 0) progress = await turn.externalProgress!.waitForChange(progress.revision, turn.abortSignal);
      await turn.externalProgress!.acknowledgeToolBatch(progress.lastToolBatchRevision); await result;
      pages.delete(turn.conversationKey!); throw continuityError("continuity_session_lost");
    }
    if (successorFails) { pages.delete(turn.conversationKey!); throw continuityError("continuity_session_lost"); }
    const candidate = { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 };
    turn.onTextDelta('{"tailValue":"UC-local-public-result"}', candidate);
    const revision = await turn.completionFence!.begin(candidate); if (revision !== undefined) await turn.completionFence!.commit(revision, candidate);
    pages.get(turn.conversationKey!)!.state = "ready";
    return '{"tailValue":"UC-local-public-result"}';
  });
  const oldLauncher = process.env.CODEX_CHATGPT_WEB_LAUNCHER;
  process.env.CODEX_CHATGPT_WEB_LAUNCHER = process.execPath;
  const config = defaultConfig("full");
  if (oldLauncher === undefined) delete process.env.CODEX_CHATGPT_WEB_LAUNCHER; else process.env.CODEX_CHATGPT_WEB_LAUNCHER = oldLauncher;
  config.browserHost = "launcher"; config.browserInteractionMode = "automatic"; config.solAvailable = true;
  const threadId = `local-${root}`, turnId = "original-turn", metadata = JSON.stringify({ thread_id: threadId, turn_id: turnId });
  const body: Row = { model: "chatgpt-web/gpt-5.6-sol", reasoning: { effort: "medium" }, stream: false,
    tools: [{ type: "function", name: "exec_command", description: "Inert delegated test source; never executes a command.", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } }],
    input: [{ type: "message", id: "original-user-source", role: "user", content: "Read one inert source and continue after its original result.", internal_chat_message_metadata_passthrough: { turn_id: turnId } }],
    client_metadata: { "x-codex-turn-metadata": metadata } };
  const store = new ContinuityRecoveryStore(statePath), thread = continuityDigest(threadId);
  const received: Array<{ body: string; headers: Readonly<Record<string, string>>; signal: AbortSignal }> = [];
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => responseRequest(request, config,
    () => createChatGptWebAdapter(provider, { broker }), { rememberState: false, onTurnIdentity: () => request.signal,
      onAdapterEvent: event => { if (event.type === "tool_call_start") dispatches++; } }) });
  const send: HarnessRequestOptions["send"] = async exact => {
    received.push(exact);
    const response = await fetch(`http://127.0.0.1:${http.port}/v1/responses`, { method: "POST", body: exact.body,
      headers: exact.headers, signal: exact.signal });
    return { response, envelope: await response.json() as Row };
  };
  const snapshot = (expectedResults: HarnessRequestSnapshot["expectedResults"]) => {
    const record = store.get(thread);
    return { record, logicalWorkId: record?.currentWorkId, sends, dispatches, expectedResults };
  };
  cleanups.push(async () => { run.mockRestore(); compatible.mockRestore(); updates.mockRestore(); await http.stop(true); await broker.close(); await server.stop(true); rmSync(root, { recursive: true, force: true }); });
  return { body, pages, send, snapshot, received, store, thread, statePath, metadata, pageRecords, compiledTexts,
    get successorRecord() { return successorRecord; } };
}

async function lostPublicContinuation(successorFails = false) {
  const f = publicLossFixture(successorFails), signal = new AbortController().signal;
  const headers = { "content-type": "application/json", "x-codex-turn-metadata": f.metadata };
  const first = await f.send({ body: JSON.stringify(f.body), headers, signal });
  expect(first.envelope.error?.code, JSON.stringify(first.envelope.error)).toBeUndefined();
  const call = first.envelope.output.find((item: Row) => item.type === "function_call"); expect(call).toBeDefined();
  const result = { type: "function_call_output", call_id: call.call_id, output: "original exact synthetic source result" };
  const body = JSON.stringify({ ...f.body, input: [...f.body.input, ...first.envelope.output, result] }); f.pages.clear();
  const expected = [{ callId: call.call_id, firstResultDigest: recoveryResultDigest(result) }];
  return { f, body, headers, signal, expected, call, result };
}

test.each(["opening", "continuation"])("actual public HTTP %s loss cold-recovers in one request with historical tools as context", async phase => {
  const { f, body, headers, signal, expected, call, result } = await lostPublicContinuation(), evidence: Row[] = [];
  const final = await runContinuityHarnessRequest({ body, headers, signal, mode: "automatic", phase, allowFailure: false,
    snapshot: () => f.snapshot(expected), send: f.send, record: value => evidence.push(value) });
  const responses = evidence.filter(value => !value.observation);
  expect(final.response.status).toBe(200); expect(final.envelope).toMatchObject({ status: "completed", end_turn: true });
  expect(responses).toHaveLength(1); expect(evidence).toHaveLength(1);
  expect(responses[0]).toMatchObject({ attempt: 1, outcome: "completed", retryAttempted: false, retryDecision: { allowed: false } });
  expect(f.received).toHaveLength(2); expect(f.received[1]!.body).toBe(body);
  expect(f.pageRecords).toHaveLength(2); expect(f.compiledTexts).toHaveLength(2);
  expect(f.received[1]!.headers).toEqual(headers); expect(f.received[1]!.signal).toBe(signal);
  expect(f.compiledTexts[1]).toContain(f.body.input[0].content);
  expect(f.compiledTexts[1]).toContain(result.output); expect(f.compiledTexts[1]).toContain("inert-synthetic-fixture-not-executed");
  expect(final.envelope.output.some((item: Row) => item.type === "function_call")).toBe(false);
  const before = f.pageRecords[0]!, acquired = f.successorRecord!, work = acquired.works[acquired.currentWorkId!]!;
  expect(acquired.currentWorkId).not.toBe(before.currentWorkId); expect(acquired.epoch).not.toBe(before.epoch);
  expect(acquired.transaction!.transactionId).not.toBe(before.transaction!.transactionId);
  expect(Object.keys(acquired.works)).toEqual([acquired.currentWorkId!]); expect(Object.keys(acquired.calls)).toEqual([]);
  expect(work.attempts).toHaveLength(1); expect(work.retryBudget!.attempts).toBe(1);
  const after = f.snapshot(expected).record!;
  expect(after.currentWorkId).toBe(acquired.currentWorkId); expect(after.works[after.currentWorkId!]!.state).toBe("completed");
  expect(after.calls[call.call_id]).toBeUndefined(); expect(after.works[after.currentWorkId!]!.retryBudget).toBeUndefined();
  expect(responses[0].after.dispatches).toBe(1); expect(responses[0].after.sends).toBe(2);
  const saved = redactContinuityEvidence(JSON.stringify(evidence), []);
  expect(saved).not.toContain(after.works[after.currentWorkId!]!.attempts[0]!.sendEvidence!.authorizationId);
  expect(saved).not.toContain(before.currentWorkId!); expect(saved).not.toContain(work.logicalWorkId);
  expect(saved).not.toContain(call.call_id); expect(saved).not.toContain(result.output);
  expect(saved).not.toContain(f.body.input[0].content); expect(saved).not.toContain(body);
});

test("the actual request consumer and final serialization never copy invalid public fields, even with no known-secret set", async () => {
  const unknown = "unknown-delivery-private-body-not-in-the-redaction-set", rows: Row[] = [];
  const envelope = { status: unknown, end_turn: { body: unknown }, error: { code: unknown, message: unknown },
    retryable: { delivery_id: unknown, body: unknown } };
  const result = await runContinuityHarnessRequest({ body: "{}", headers: { "content-type": "application/json" }, signal: new AbortController().signal,
    mode: "automatic", phase: "opening", allowFailure: false,
    snapshot: () => ({ sends: 0, dispatches: 0, expectedResults: [] }),
    send: async () => ({ response: Response.json(envelope), envelope }), record: row => rows.push(row) });
  expect(result.envelope).toEqual(envelope); // Observation must not change the original response.
  expect(rows).toHaveLength(1);
  const shared = redactContinuityEvidence(JSON.stringify({ requests: rows }), []);
  expect(shared).not.toContain(unknown);
  expect(rows[0]).toMatchObject({ outcome: null, endTurn: null, errorCode: null,
    retryablePresent: true, retryableType: "object", retryable: null, retryDecision: { allowed: false } });
  for (const field of ["invalidOutcomeDigest", "invalidEndTurnDigest", "invalidErrorCodeDigest", "invalidRetryableDigest"])
    expect(rows[0][field]).toMatch(/^[a-f0-9]{64}$/);
  // These are the same whitelist and final serializer used by the main HTTP/event consumers.
  const events = [{ kind: "http-response", ...summarizeHarnessResponse(envelope) },
    { kind: "adapter-outcome", ...summarizeHarnessResponse({ error: envelope.error, retryable: envelope.retryable }) }];
  expect(redactContinuityEvidence(JSON.stringify({ requests: rows, events }), [])).not.toContain(unknown);
});

test("a new-page actual public HTTP failure does not trigger another request or a third generation", async () => {
  const { f, body, headers, signal, expected } = await lostPublicContinuation(true), rows: Row[] = [];
  const final = await runContinuityHarnessRequest({ body, headers, signal, mode: "automatic", phase: "continuation", allowFailure: false,
    snapshot: () => f.snapshot(expected), send: f.send, record: row => rows.push(row) });
  const responses = rows.filter(row => !row.observation);
  expect(final.envelope.status).toBe("failed");
  expect(final.envelope.error?.code, JSON.stringify(final.envelope.error)).toEqual(expect.any(String));
  expect(responses).toHaveLength(1); expect(rows).toHaveLength(1);
  expect(responses[0]).toMatchObject({ attempt: 1, retryAttempted: false, retryDecision: { allowed: false } });
  expect(f.received).toHaveLength(2); expect(f.received[1]!.body).toBe(body);
  expect(f.received[1]!.headers).toEqual(headers); expect(f.received[1]!.signal).toBe(signal);
  const acquired = f.successorRecord!, before = f.pageRecords[0]!, snapshot = f.snapshot(expected);
  expect(f.pageRecords).toHaveLength(2); expect(acquired.currentWorkId).not.toBe(before.currentWorkId);
  expect(acquired.epoch).not.toBe(before.epoch);
  expect(acquired.transaction!.transactionId).not.toBe(before.transaction!.transactionId);
  expect(acquired.works[acquired.currentWorkId!]!.attempts).toHaveLength(1);
  expect(snapshot.record).toBeUndefined(); expect(f.pages.size).toBe(0);
  expect(snapshot.dispatches).toBe(1); expect(snapshot.sends).toBe(2);
});

/** Controlled live-page protocol facts, built through production store APIs.
 * Responses here are synthetic. This fixture proves the harness predicate, not HTTP or Launcher recovery. */
function liveRetryProtocolFixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-live-retry-protocol-"));
  new ContinuityRegistrationStore(root).initialize();
  const store = new ContinuityRecoveryStore(root), thread = continuityDigest(root), scope = continuityDigest("live-protocol-scope");
  const owner = continuityProcessInstance(), logicalWorkId = "private-live-protocol-work", callId = "private-live-protocol-call";
  const result = { type: "function_call_output", call_id: callId, output: "private exact live protocol result" };
  const request = { model: "chatgpt-web/gpt-5.6-sol", stream: false,
    input: [{ type: "message", role: "user", content: "private live protocol instruction" },
      { type: "function_call", call_id: callId, name: "exec_command", arguments: '{"cmd":"inert"}' }, result],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: "original-turn" }) } };
  const record = store.admitWork({ thread, scope, owner, logicalWorkId, instructionIdentity: "live-instruction",
    workPayloadDigest: continuityDigest(request.input[0]), snapshotDigest: continuityDigest(request),
    nativeTurnId: "original-turn", dispatchProtocolComplete: true, createPage: true });
  const identity = recoveryIdentity(record, store.installationId()), authorizationId = "private-live-send-authorization";
  store.markAttempt(thread, { scope }, { logicalWorkId, attempt: 0, stage: "send-possible", sendAuthorizationId: authorizationId });
  store.settleSendReceipt(thread, { scope }, identity, authorizationId);
  store.issueBatch(thread, { scope }, { logicalWorkId, attempt: 0,
    calls: [{ callId, operationId: "live-operation", expectedResultType: "function_call_output" }] });
  store.markDeliveryPossible(thread, { scope }, [callId]);
  const firstResultDigest = recoveryResultDigest(result);
  store.acceptResult(thread, { scope }, { callId, resultType: "function_call_output", resultDigest: firstResultDigest });
  const expected = [{ callId, firstResultDigest }], body = JSON.stringify(request);
  const headers = { "content-type": "application/json", authorization: "Bearer private-live-header" }, signal = new AbortController().signal;
  const envelope = { status: "failed", error: { code: "continuity_session_lost" }, retryable: true };
  const failure = { response: Response.json(envelope), envelope };
  const snapshot = (): HarnessRequestSnapshot => ({ record: store.get(thread), logicalWorkId, sends: 1, dispatches: 1, expectedResults: expected });
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  return { body, headers, signal, failure, snapshot, store, thread, result, callId, authorizationId };
}

test.each(["opening", "continuation"])("controlled live-page protocol permits one exact %s retry and preserves both observations", async phase => {
  const p = liveRetryProtocolFixture(), rows: Row[] = [], received: Parameters<HarnessRequestOptions["send"]>[0][] = [];
  const completed = { response: Response.json({ status: "completed", end_turn: true }), envelope: { status: "completed", end_turn: true } };
  const originalRecord = p.store.get(p.thread);
  const result = await runContinuityHarnessRequest({ body: p.body, headers: p.headers, signal: p.signal,
    mode: "automatic", phase, allowFailure: false, snapshot: p.snapshot,
    send: async exact => { received.push(exact); return received.length === 1 ? p.failure : completed; }, record: row => rows.push(row) });
  expect(result).toBe(completed); expect(received).toHaveLength(2); expect(received[0]).toBe(received[1]);
  expect(received[1]!.body).toBe(p.body); expect(received[1]!.headers).toEqual(p.headers); expect(received[1]!.signal).toBe(p.signal);
  const responses = rows.filter(row => !row.observation);
  expect(responses).toHaveLength(2);
  expect(responses[0]).toMatchObject({ attempt: 1, outcome: "failed", retryablePresent: true, retryable: true,
    retryAttempted: false, retryDecision: { allowed: true }, after: { durable: { state: "active", calls: [{ state: "settled" }] } } });
  expect(responses[1]).toMatchObject({ attempt: 2, outcome: "completed", retryAttempted: true, retryDecision: { allowed: false } });
  expect(rows.find(row => row.observation === "retry-authorized")?.retryAuthorized).toBe(true);
  expect(p.store.get(p.thread)).toEqual(originalRecord);
  const shared = redactContinuityEvidence(JSON.stringify(rows), []);
  for (const secret of [p.authorizationId, p.callId, p.result.output, p.headers.authorization, "private live protocol instruction", p.body])
    expect(shared).not.toContain(secret);
});

test("controlled live-page protocol stops after one additional failed request", async () => {
  const p = liveRetryProtocolFixture(), rows: Row[] = []; let requests = 0;
  const result = await runContinuityHarnessRequest({ body: p.body, headers: p.headers, signal: p.signal,
    mode: "automatic", phase: "continuation", allowFailure: false, snapshot: p.snapshot,
    send: async () => { requests++; return p.failure; }, record: row => rows.push(row) });
  expect(result).toBe(p.failure); expect(requests).toBe(2);
  const responses = rows.filter(row => !row.observation);
  expect(responses).toHaveLength(2); expect(responses[0].retryDecision.allowed).toBe(true);
  expect(responses[1]).toMatchObject({ attempt: 2, retryAttempted: true,
    retryDecision: { allowed: false, reason: "one additional request has already been spent" } });
});

const refusalReasons = {
  public: "public response does not explicitly authorize this retry",
  request: "request mode or phase is excluded",
  body: "actual public body is not ordinary",
  serialized: "serialized body does not contain the original exact results",
  send: "original accepted Send or complete execution cannot be proved",
  work: "original active ordinary work changed or is unproven",
  results: "original result set or first digests are unsettled or changed",
  budget: "original durable retry budget or deadline is exhausted or changed",
  counters: "first request sent or dispatched new work, or original counters are unproven",
};
type Refusal = { name: string; reason: keyof typeof refusalReasons; envelope?(value: Row): void; options?: Partial<Pick<HarnessRequestOptions, "mode" | "phase" | "allowFailure">>;
  body?(value: Row): void; snapshot?(value: HarnessRequestSnapshot, observation: number): void };
const refusals: Refusal[] = [
  { name: "missing retryable", reason: "public", envelope: value => { delete value.retryable; } },
  { name: "retryable false", reason: "public", envelope: value => { value.retryable = false; } },
  { name: "retryable string", reason: "public", envelope: value => { value.retryable = "true"; } },
  { name: "retryable null", reason: "public", envelope: value => { value.retryable = null; } },
  { name: "retryable object", reason: "public", envelope: value => { value.retryable = { body: "not a boolean" }; } },
  { name: "ACK failure", reason: "public", envelope: value => { value.error.code = "task_update_unacknowledged"; } },
  { name: "non-failed outcome", reason: "public", envelope: value => { value.status = "completed"; } },
  { name: "allowFailure observation", reason: "request", options: { allowFailure: true } },
  { name: "Zero Risk", reason: "request", options: { mode: "zero-risk" } },
  { name: "source phase", reason: "request", options: { phase: "source" } },
  { name: "checkpoint consumer", reason: "request", options: { phase: "checkpoint-continuation" } },
  { name: "existing compaction retry", reason: "request", options: { phase: "compaction-retry" } },
  { name: "public compaction disguised as opening", reason: "body", body: value => Object.assign(value, compactionBody(value, "original-turn")) },
  { name: "changed serialized result", reason: "serialized", body: value => { value.input.at(-1).output += "changed"; } },
  { name: "missing serialized result", reason: "serialized", body: value => { value.input.pop(); } },
  { name: "unknown Send", reason: "send", snapshot: value => { value.record!.works[value.logicalWorkId!]!.attempts.at(-1)!.sendEvidence!.status = "possible"; } },
  { name: "incomplete dispatch", reason: "send", snapshot: value => { value.record!.works[value.logicalWorkId!]!.attempts.at(-1)!.dispatchProtocolComplete = false; } },
  { name: "user stop", reason: "work", snapshot: value => { value.record!.works[value.logicalWorkId!]!.state = "stopped"; } },
  { name: "unsettled result", reason: "results", snapshot: value => { Object.values(value.record!.calls)[0]!.state = "delivery-possible"; } },
  { name: "changed first result digest", reason: "results", snapshot: value => { Object.values(value.record!.calls)[0]!.firstResultDigest = "0".repeat(64); } },
  { name: "expired original deadline", reason: "budget", snapshot: value => { value.record!.works[value.logicalWorkId!]!.retryBudget!.deadlineAt = Date.now() - 10000; } },
  { name: "exhausted original retry budget", reason: "budget", snapshot: value => { value.record!.works[value.logicalWorkId!]!.retryBudget!.attempts = 4; } },
  { name: "missing original retry budget", reason: "budget", snapshot: value => { delete value.record!.works[value.logicalWorkId!]!.retryBudget; } },
  { name: "first request added a Send", reason: "counters", snapshot: (value, observation) => { if (observation > 1) value.sends++; } },
  { name: "first request dispatched new work", reason: "counters", snapshot: (value, observation) => { if (observation > 1) value.dispatches++; } },
  { name: "original work epoch changed", reason: "work", snapshot: (value, observation) => { if (observation > 1) value.record!.epoch++; } },
  { name: "original budget start changed", reason: "budget", snapshot: (value, observation) => { if (observation > 1) value.record!.works[value.logicalWorkId!]!.retryBudget!.startedAt--; } },
];

test.each(refusals)("controlled live-page protocol refuses $name at its own guard without a successor request", async control => {
  const p = liveRetryProtocolFixture(), rows: Row[] = [], envelope = structuredClone(p.failure.envelope), body = JSON.parse(p.body);
  control.envelope?.(envelope); control.body?.(body);
  let requests = 0, observations = 0;
  const originalRecord = p.store.get(p.thread);
  const result = await runContinuityHarnessRequest({ body: JSON.stringify(body), headers: p.headers, signal: p.signal,
    mode: "automatic", phase: "opening", allowFailure: false, ...control.options,
    snapshot: () => { const value = p.snapshot(); control.snapshot?.(value, ++observations); return value; },
    send: async () => { requests++; return { response: Response.json(envelope), envelope }; },
    record: row => rows.push(row) });
  expect(result.envelope).toEqual(envelope); expect(requests).toBe(1);
  expect(rows).toHaveLength(1); expect(rows[0].retryDecision).toEqual({ allowed: false, reason: refusalReasons[control.reason] });
  expect(p.store.get(p.thread)).toEqual(originalRecord);
});

test.each(["after-first-response", "after-authorization"])("fresh durable recheck blocks late activity %s before any successor send", async boundary => {
  const p = liveRetryProtocolFixture(), rows: Row[] = []; let changed = false, requests = 0;
  const result = await runContinuityHarnessRequest({ body: p.body, headers: p.headers, signal: p.signal, mode: "automatic", phase: "opening", allowFailure: false,
    snapshot: () => ({ ...p.snapshot(), ...(changed ? { sends: 2 } : {}) }),
    send: async () => { requests++; return p.failure; },
    record: row => { rows.push(row); if (boundary === "after-first-response" && !row.observation || boundary === "after-authorization" && row.observation === "retry-authorized") changed = true; } });
  expect(result).toBe(p.failure); expect(requests).toBe(1);
  expect(rows[0].retryDecision.allowed).toBe(true);
  expect(rows.at(-1)).toMatchObject({ observation: "before-retry-recheck", retryDecision: { allowed: false, reason: refusalReasons.counters } });
  expect(rows.some(row => row.observation === "retry-authorized")).toBe(boundary === "after-authorization");
  expect(rows.filter(row => !row.observation)).toHaveLength(1);
});

test.each([true, false, null, undefined])("public retryable observation preserves valid value %s and its original presence", value => {
  const envelope = value === undefined ? {} : { retryable: value }, row = summarizeHarnessResponse(envelope);
  expect(row.retryablePresent).toBe(value !== undefined); expect(row.retryable).toBe(value ?? null);
  expect(row.retryableType).toBe(value === undefined ? "absent" : value === null ? "null" : "boolean");
  expect(row.invalidRetryableDigest).toBeUndefined();
});

test("malformed fields from the real Responses builder stay out of shared evidence and non-200 diagnostics", async () => {
  const unknown = "uncollected-delivery-and-private-content", rows: Row[] = [];
  // Controlled malformed adapter values exercise the actual public JSON builder,
  // then the same consuming/serializing boundary. They are not validated live facts.
  const events = [{ type: "done", endTurn: { body: unknown } },
    { type: "error", code: unknown, message: unknown, retryable: { delivery_id: unknown, body: unknown } }] as unknown as AdapterEvent[];
  const envelope = buildResponseJSON(events, "chatgpt-web/gpt-5.6-sol");
  const original = JSON.stringify(envelope);
  const result = await runContinuityHarnessRequest({ body: "{}", headers: { "content-type": "application/json" }, signal: new AbortController().signal,
    mode: "automatic", phase: "opening", allowFailure: false,
    snapshot: () => ({ sends: 0, dispatches: 0, expectedResults: [] }),
    send: async () => ({ response: Response.json(envelope, { status: 500 }), envelope }), record: row => rows.push(row) });
  expect(JSON.stringify(result.envelope)).toBe(original); expect(result.response.status).toBe(500);
  expect(rows[0]).toMatchObject({ outcome: "failed", httpStatus: 500, errorCode: null, retryablePresent: true,
    retryableType: "object", endTurnType: "object", retryDecision: { allowed: false } });
  const http = summarizeHarnessResponse(result.envelope), diagnostic = `真实 Responses 失败：${JSON.stringify({ httpStatus: result.response.status, ...http })}`;
  const shared = redactContinuityEvidence(JSON.stringify({ requests: rows, events: [{ kind: "http-response", ...http }], failure: diagnostic }), []);
  expect(shared).not.toContain(unknown); expect(shared).not.toContain("delivery_id");
  expect(rows).toHaveLength(1);
});
