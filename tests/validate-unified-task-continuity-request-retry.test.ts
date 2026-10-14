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
import { recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import type { ContinuityClaim, ContinuityLease } from "../src/adapters/chatgpt-web/continuity-contract";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE } from "../src/adapters/chatgpt-web/continuity-contract";
import { CONTINUITY_EXECUTION_FENCING_FEATURE, LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";

type Row = Record<string, any>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { chatGptTurnSessions.clear(); for (const close of cleanups.splice(0).reverse()) await close(); });

/** Public Responses + production adapter/Broker/store; only physical worker/Launcher are controlled.
 * Derived from the independent ordinary06 public fixture. No browser, DEV or real Send. */
function publicLossFixture(successorFails = false) {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-retry8-")), statePath = join(root, "continuity");
  new ContinuityRegistrationStore(statePath).initialize();
  const processInstance = continuityProcessInstance();
  const launcherInstance = { pid: process.pid, startIdentity: processInstance.startIdentity, instanceId: "a".repeat(64) };
  const pages = new Map<string, { continuity: ContinuityLease; state: "ready" | "running" }>();
  let sends = 0, dispatches = 0, browserRuns = 0;
  let successorRecord: RecoveryThreadRecord | undefined;
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
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `fixture://${root}`, chatgptWeb: {
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
    if (browserRuns > 1) successorRecord = store.get(thread);
    const compiled = await turn.prepare(); if (compiled.contextPlan) await turn.onContextPlanSelected!(compiled.contextPlan.planId);
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
  const send: HarnessRequestOptions["send"] = async exact => {
    received.push(exact);
    const response = await responseRequest(new Request("http://local-continuity.invalid/v1/responses", { method: "POST", body: exact.body,
      headers: exact.headers, signal: exact.signal }), config, () => createChatGptWebAdapter(provider, { broker }),
    { rememberState: false, onTurnIdentity: () => exact.signal, onAdapterEvent: event => { if (event.type === "tool_call_start") dispatches++; } });
    return { response, envelope: await response.json() as Row };
  };
  const snapshot = (expectedResults: HarnessRequestSnapshot["expectedResults"]) => {
    const record = store.get(thread);
    return { record, logicalWorkId: record?.currentWorkId, sends, dispatches, expectedResults };
  };
  cleanups.push(async () => { run.mockRestore(); compatible.mockRestore(); updates.mockRestore(); await broker.close(); await server.stop(true); rmSync(root, { recursive: true, force: true }); });
  return { body, pages, send, snapshot, received, store, thread, statePath, metadata, get successorRecord() { return successorRecord; } };
}

test.each(["opening", "continuation"])("actual public %s result-only loss retries once through the same harness boundary, preserving source, results and both responses", async phase => {
  const f = publicLossFixture(), signal = new AbortController().signal;
  const headers = { "content-type": "application/json", "x-codex-turn-metadata": f.metadata };
  const first = await f.send({ body: JSON.stringify(f.body), headers, signal });
  expect(first.envelope.error?.code).toBeUndefined();
  const call = first.envelope.output.find((item: Row) => item.type === "function_call"); expect(call).toBeDefined();
  const result = { type: "function_call_output", call_id: call.call_id, output: "original exact synthetic source result" };
  const body = JSON.stringify({ ...f.body, input: [...f.body.input, ...first.envelope.output, result] }); f.pages.clear();
  const expected = [{ callId: call.call_id, firstResultDigest: recoveryResultDigest(result) }], evidence: Row[] = [];
  const before = f.snapshot(expected).record!;
  const final = await runContinuityHarnessRequest({ body, headers, signal, mode: "automatic", phase, allowFailure: false,
    snapshot: () => f.snapshot(expected), send: f.send, record: value => evidence.push(value) });
  const responses = evidence.filter(value => !value.observation);
  expect(final.envelope).toMatchObject({ status: "completed", end_turn: true }); expect(responses).toHaveLength(2);
  expect(responses[0]).toMatchObject({ outcome: "failed", errorCode: "continuity_session_lost", retryablePresent: true, retryable: true, retryAttempted: false, retryDecision: { allowed: true } });
  expect(responses[0].before.sends).toBe(responses[0].after.sends); expect(responses[0].before.dispatches).toBe(responses[0].after.dispatches);
  expect(responses[1]).toMatchObject({ attempt: 2, outcome: "completed", retryAttempted: true });
  expect(evidence.find(value => value.observation === "retry-authorized")?.retryAuthorized).toBe(true);
  expect(f.received).toHaveLength(3); expect(f.received[1]!.body).toBe(body); expect(f.received[2]!.body).toBe(body);
  expect(f.received[1]!.headers).toBe(f.received[2]!.headers); expect(f.received[1]!.signal).toBe(signal); expect(f.received[2]!.signal).toBe(signal);
  const after = f.snapshot(expected).record!;
  expect(after.currentWorkId).toBe(before.currentWorkId); expect(after.epoch).toBe(1);
  expect(after.works[after.currentWorkId!]!.attempts).toHaveLength(2);
  expect(Object.keys(after.calls)).toEqual(Object.keys(before.calls)); expect(after.calls[call.call_id]!.firstResultDigest).toBe(expected[0]!.firstResultDigest);
  expect(responses[0].after.durable.state).toBe("active"); expect(responses[0].after.durable.calls[0].state).toBe("settled");
  expect(responses[1].after.dispatches).toBe(1); expect(responses[1].after.sends).toBe(2);
  const acquired = f.successorRecord!, work = acquired.works[acquired.currentWorkId!]!, originalBudget = responses[0].after.durable.retryBudget;
  expect(acquired.currentWorkId).toBe(before.currentWorkId); expect(acquired.epoch).toBe(1);
  expect(work.retryBudget).toMatchObject({ attempts: originalBudget.attempts + 1, startedAt: originalBudget.startedAt });
  expect(work.retryBudget!.deadlineAt ?? null).toBe(originalBudget.deadlineAt ?? null);
  expect(after.works[after.currentWorkId!]!.retryBudget).toBeUndefined(); // Completed product records delete the budget.
  const saved = redactContinuityEvidence(JSON.stringify(evidence), []);
  expect(saved).not.toContain(work.attempts[0]!.sendEvidence!.authorizationId);
  expect(saved).not.toContain(call.call_id);
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

async function savedPublicFailure(successorFails = false) {
  const f = publicLossFixture(successorFails), signal = new AbortController().signal;
  const headers = { "content-type": "application/json", "x-codex-turn-metadata": f.metadata };
  const source = await f.send({ body: JSON.stringify(f.body), headers, signal });
  const call = source.envelope.output.find((item: Row) => item.type === "function_call");
  const result = { type: "function_call_output", call_id: call.call_id, output: "original exact synthetic source result" };
  const body = JSON.stringify({ ...f.body, input: [...f.body.input, ...source.envelope.output, result] }); f.pages.clear();
  const failure = await f.send({ body, headers, signal });
  expect(failure.envelope).toMatchObject({ status: "failed", error: { code: "continuity_session_lost" }, retryable: true });
  const expected = [{ callId: call.call_id, firstResultDigest: recoveryResultDigest(result) }];
  return { f, body, headers, signal, failure, expected, call, result };
}

test("a second actual public failure stops without a third request or a third generation", async () => {
  const f = publicLossFixture(true), signal = new AbortController().signal;
  const headers = { "content-type": "application/json", "x-codex-turn-metadata": f.metadata };
  const source = await f.send({ body: JSON.stringify(f.body), headers, signal });
  const call = source.envelope.output.find((item: Row) => item.type === "function_call");
  const result = { type: "function_call_output", call_id: call.call_id, output: "original exact synthetic source result" };
  const body = JSON.stringify({ ...f.body, input: [...f.body.input, ...source.envelope.output, result] }); f.pages.clear();
  const expected = [{ callId: call.call_id, firstResultDigest: recoveryResultDigest(result) }], rows: Row[] = [];
  const final = await runContinuityHarnessRequest({ body, headers, signal, mode: "automatic", phase: "continuation", allowFailure: false,
    snapshot: () => f.snapshot(expected), send: f.send, record: row => rows.push(row) });
  const responses = rows.filter(row => !row.observation);
  expect(final.envelope).toMatchObject({ status: "failed", error: { code: "continuity_session_lost" } });
  expect(responses).toHaveLength(2); expect(responses[1].retryDecision.allowed).toBe(false);
  expect(f.received).toHaveLength(3); expect(f.received[2]!.body).toBe(body);
  const snapshot = f.snapshot(expected), work = snapshot.record!.works[snapshot.logicalWorkId!]!;
  expect(work.state).toBe("active"); expect(work.attempts).toHaveLength(2); expect(snapshot.record!.epoch).toBe(1);
  expect(snapshot.dispatches).toBe(1); expect(snapshot.sends).toBe(2);
  expect(work.retryBudget!.attempts).toBe(2); expect(work.stopReason).toBeUndefined();
  expect(snapshot.record!.calls[call.call_id]!.firstResultDigest).toBe(expected[0]!.firstResultDigest);
});

type Refusal = { name: string; envelope?(value: Row): void; options?: Partial<Pick<HarnessRequestOptions, "mode" | "phase" | "allowFailure">>;
  body?(value: Row): void; snapshot?(value: HarnessRequestSnapshot, observation: number): void };
const refusals: Refusal[] = [
  { name: "missing retryable", envelope: value => { delete value.retryable; } },
  { name: "retryable false", envelope: value => { value.retryable = false; } },
  { name: "retryable string", envelope: value => { value.retryable = "true"; } },
  { name: "retryable null", envelope: value => { value.retryable = null; } },
  { name: "retryable object", envelope: value => { value.retryable = { body: "not a boolean" }; } },
  { name: "ACK failure", envelope: value => { value.error.code = "task_update_unacknowledged"; } },
  { name: "non-failed outcome", envelope: value => { value.status = "completed"; } },
  { name: "allowFailure observation", options: { allowFailure: true } },
  { name: "Zero Risk", options: { mode: "zero-risk" } },
  { name: "source phase", options: { phase: "source" } },
  { name: "checkpoint consumer", options: { phase: "checkpoint-continuation" } },
  { name: "existing compaction retry", options: { phase: "compaction-retry" } },
  { name: "public compaction disguised as opening", body: value => Object.assign(value, compactionBody(value, "original-turn")) },
  { name: "changed serialized result", body: value => { value.input.at(-1).output += "changed"; } },
  { name: "missing serialized result", body: value => { value.input.pop(); } },
  { name: "unknown Send", snapshot: value => { value.record!.works[value.logicalWorkId!]!.attempts.at(-1)!.sendEvidence!.status = "possible"; } },
  { name: "incomplete dispatch", snapshot: value => { value.record!.works[value.logicalWorkId!]!.attempts.at(-1)!.dispatchProtocolComplete = false; } },
  { name: "user stop", snapshot: value => { value.record!.works[value.logicalWorkId!]!.state = "stopped"; } },
  { name: "unsettled result", snapshot: value => { Object.values(value.record!.calls)[0]!.state = "delivery-possible"; } },
  { name: "changed first result digest", snapshot: value => { Object.values(value.record!.calls)[0]!.firstResultDigest = "0".repeat(64); } },
  { name: "expired original deadline", snapshot: value => { value.record!.works[value.logicalWorkId!]!.retryBudget!.deadlineAt = Date.now() - 10000; } },
  { name: "exhausted original retry budget", snapshot: value => { value.record!.works[value.logicalWorkId!]!.retryBudget!.attempts = 4; } },
  { name: "missing original retry budget", snapshot: value => { delete value.record!.works[value.logicalWorkId!]!.retryBudget; } },
  { name: "first request added a Send", snapshot: (value, observation) => { if (observation > 1) value.sends++; } },
  { name: "first request dispatched new work", snapshot: (value, observation) => { if (observation > 1) value.dispatches++; } },
  { name: "original work epoch changed", snapshot: (value, observation) => { if (observation > 1) value.record!.epoch++; } },
  { name: "original budget start changed", snapshot: (value, observation) => { if (observation > 1) value.record!.works[value.logicalWorkId!]!.retryBudget!.startedAt--; } },
];

test.each(refusals)("saved real public failure refuses $name without calling the successor consumer", async control => {
  const p = await savedPublicFailure(), rows: Row[] = [], envelope = structuredClone(p.failure.envelope), body = JSON.parse(p.body);
  control.envelope?.(envelope); control.body?.(body);
  let requests = 0, observations = 0;
  const originalRecord = JSON.stringify(p.f.store.get(p.f.thread));
  const result = await runContinuityHarnessRequest({ body: JSON.stringify(body), headers: p.headers, signal: p.signal,
    mode: "automatic", phase: "opening", allowFailure: false, ...control.options,
    snapshot: () => { const value = p.f.snapshot(p.expected); control.snapshot?.(value, ++observations); return value; },
    send: async exact => { requests++; return requests === 1 ? { response: Response.json(envelope), envelope } : p.f.send(exact); },
    record: row => rows.push(row) });
  expect(result.envelope).toEqual(envelope); expect(requests).toBe(1); expect(p.f.received).toHaveLength(2);
  expect(rows).toHaveLength(1); expect(rows[0].retryDecision.allowed).toBe(false);
  expect(JSON.stringify(p.f.store.get(p.f.thread))).toBe(originalRecord);
});

test.each(["after-first-response", "after-authorization"])("fresh durable recheck blocks late activity %s before any successor send", async boundary => {
  const p = await savedPublicFailure(), rows: Row[] = []; let changed = false, requests = 0;
  const result = await runContinuityHarnessRequest({ body: p.body, headers: p.headers, signal: p.signal, mode: "automatic", phase: "opening", allowFailure: false,
    snapshot: () => ({ ...p.f.snapshot(p.expected), ...(changed ? { sends: 2 } : {}) }),
    send: async exact => { requests++; return requests === 1 ? p.failure : p.f.send(exact); },
    record: row => { rows.push(row); if (boundary === "after-first-response" && !row.observation || boundary === "after-authorization" && row.observation === "retry-authorized") changed = true; } });
  expect(result).toBe(p.failure); expect(requests).toBe(1); expect(p.f.received).toHaveLength(2);
  expect(rows.at(-1)).toMatchObject({ observation: "before-retry-recheck", retryDecision: { allowed: false } });
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
