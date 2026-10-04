import { expect, test } from "bun:test";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import { parseRequest } from "../src/responses/parser";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { trustedChatGptTaskUpdateUserText } from "../src/adapters/chatgpt-web/environment";
import { captureTaskUpdateSource } from "../src/adapters/chatgpt-web/task-update-source";
import type { BrokerToolRequest } from "../src/adapters/chatgpt-web/turn-broker";
import type { TaskUpdateState, TaskUpdateTransferOutcome } from "../src/adapters/chatgpt-web/task-update-protocol";
import {
  ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession, ChatGptTurnSessions,
  chatGptTurnExecutionKey, chatGptTurnRoundKey, type ChatGptTaskUpdateProof,
  type ChatGptTurnRuntime,
  TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES, TASK_UPDATE_SESSION_JOURNAL_BYTES,
} from "../src/adapters/chatgpt-web/turn-execution";

const execution = { capabilityIdentity: { epoch: "original-capability", namespace: "native", account: "same-account" }, executionConfig: { mode: "Automatic", sandbox: "workspace" } };
const req: BrokerToolRequest = { callId: "call-a", wireName: "exec_command", freeform: false, arguments: { cmd: "echo actual" } };
const result = { type: "function_call_output", call_id: req.callId, output: " exact actual result\n", _meta: { retained: true } };
function user(id: string, content = "Initial work", kinds: string[] | null = ["user.text"]): Record<string, unknown> {
  return { type: "message", id, role: "user", content: [{ type: "input_text", text: content }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn", ...(kinds ? { content_item_kinds: kinds } : {}) } };
}
function request(input: unknown[] = [user("initial")], requestId?: string): CodexParsedRequest {
  return parseRequest({ model: "gpt-6.1-sol", instructions: "Fixed system instructions", input,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread", turn_id: "turn", ...(requestId ? { request_id: requestId } : {}) }) } });
}
function fixture(parsed = request(), conversationKey?: string) {
  let finishBrowser!: (answer: string) => void;
  let settlePhysical!: () => void;
  let retirements = 0;
  let cancellations = 0;
  let retired!: () => void;
  const retirement = new Promise<void>(resolve => { retired = resolve; });
  const taskUpdates: NonNullable<ChatGptTurnRuntime["taskUpdates"]> = { protocolVersion: 1 };
  const runtime = { mode: "tools" as const, token: Promise.resolve("physical-token"), taskUpdates, conversationKey,
    browser: new Promise<string>(resolve => { finishBrowser = resolve; }),
    physicalSettlement: new Promise<void>(resolve => { settlePhysical = resolve; }),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), externalProgress: new ChatGptExternalTurnProgress(),
    cancel: () => { cancellations++; }, retireCapability: () => { retirements++; retired(); } };
  const session = new ChatGptTurnSession(runtime, "trace", "owner", "turn", "thread");
  expect(session.initializeTaskUpdates(parsed, execution)).toBeTrue();
  return { parsed, session, runtime, finishBrowser, settlePhysical, retirement, retirements: () => retirements, cancellations: () => cancellations };
}
function emitBatch(session: ChatGptTurnSession, parsed: CodexParsedRequest, requests: BrokerToolRequest[] = [req], observe = true) {
  const round = chatGptTurnRoundKey(parsed);
  session.setOutstanding(requests);
  const events: AdapterEvent[] = requests.flatMap(request => [
    { type: "tool_call_start", id: request.callId, name: request.wireName },
    { type: "tool_call_delta", arguments: JSON.stringify(request.arguments ?? {}) },
    { type: "tool_call_end" },
  ] as AdapterEvent[]);
  session.appendRoundEvents(round, [...events, { type: "done", stopReason: "tool_use", endTurn: false }]);
  session.completeRound(round);
  if (observe) session.recordTaskUpdateToolBatch(round, requests, 1);
  return round;
}
function eligible(proof: ChatGptTaskUpdateProof) {
  expect(proof.status).toBe("eligible");
  if (proof.status !== "eligible") throw new Error(`Unexpected proof: ${proof.status}`);
  return proof;
}
function state(revision: number, generation: number): TaskUpdateState {
  return { acceptedRevision: revision, deliveredRevision: revision, acknowledgedRevision: 0, driverGeneration: generation, finalOutputRevision: null };
}
function commit(session: ChatGptTurnSession, proof: ReturnType<typeof eligible>, id = "transfer"): TaskUpdateTransferOutcome {
  session.prepareTaskUpdate(proof, id, `digest:${id}`);
  const outcome: TaskUpdateTransferOutcome = { status: "committed", transferId: id,
    state: state(proof.route.acceptedRevision, proof.route.driverGeneration), batchFingerprint: proof.batch.batchFingerprint };
  expect(session.finishTaskUpdateTransfer(outcome)).toBe("committed");
  return outcome;
}
function storage(session: ChatGptTurnSession) {
  const budget = session as unknown as { taskUpdateSourceBytes: number; taskUpdateJournalBytes: number;
    taskUpdateErrorRoundReserves: Set<string>; preparedTaskUpdate?: { sourceBytes: number; handoffBytes: number } };
  const used = budget.taskUpdateSourceBytes + budget.taskUpdateJournalBytes
    + budget.taskUpdateErrorRoundReserves.size * TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES
    + (budget.preparedTaskUpdate?.sourceBytes ?? 0) + (budget.preparedTaskUpdate?.handoffBytes ?? 0);
  return { used, available: TASK_UPDATE_SESSION_JOURNAL_BYTES - used, journal: budget.taskUpdateJournalBytes,
    errorRounds: budget.taskUpdateErrorRoundReserves.size };
}
function fillOrdinaryJournal(session: ChatGptTurnSession, roundKey: string, leave = 0) {
  const event = { type: "text_delta" as const, text: "", phase: "commentary" as const };
  const overhead = Buffer.byteLength(JSON.stringify([event]));
  event.text = "x".repeat(storage(session).available - overhead - leave);
  session.appendRoundEvents(roundKey, [event]);
}

test("normal user provenance excludes generic instructions, agents, environment and tool payloads", () => {
  expect(trustedChatGptTaskUpdateUserText(user("human"), "turn")?.sourceMessageId).toBe("human");
  expect(trustedChatGptTaskUpdateUserText(user("api-key", "real text", null), "turn")?.content).toBe("real text");
  for (const item of [user("generic", "instructions", ["agents_md.instructions"]),
    { ...user("agent"), type: "agent_message", author: "/root" },
    user("env", "<environment_context>...</environment_context>", ["environments.environment_context"]),
    user("old-preamble", "# AGENTS.md instructions for /workspace", null),
    { type: "function_call_output", call_id: "tool", output: JSON.stringify(user("fake")) },
    { ...user("no-owner"), internal_chat_message_metadata_passthrough: undefined },
    { ...user("no-id"), id: undefined },
    { ...user("image"), content: [{ type: "input_image", image_url: "data:image/png;base64,eA==" }] },
  ]) expect(trustedChatGptTaskUpdateUserText(item, "turn")).toBeUndefined();
  const onlyGeneric = request([user("generic", "instruction history", ["generic.instructions"])]);
  expect(captureTaskUpdateSource(onlyGeneric, execution)).toBeUndefined();
});

test("strict prefix accepts ordered multiple additions and identical text under distinct native IDs", () => {
  const { parsed, session } = fixture();
  emitBatch(session, parsed);
  const proof = eligible(session.proveTaskUpdate(request([user("initial"), result, user("one", "same text"), user("two", "same text")]), execution));
  expect(proof.updates.map(update => [update.revision, update.sourceMessageId, update.content])).toEqual([
    [1, "one", "same text"], [2, "two", "same text"],
  ]);
  const sourceRound = session.roundEvents(chatGptTurnRoundKey(parsed));
  const receipt = commit(session, proof);
  expect(session.taskRevision()).toBe(2);
  expect(session.driverGeneration()).toBe(1);
  expect(session.outstanding()).toEqual([]);
  expect(session.roundEvents(chatGptTurnRoundKey(parsed))).toEqual(sourceRound);
  expect(session.finishTaskUpdateTransfer(receipt)).toBe("committed");
});

test("edited or reordered accepted prefix, immutable config and capability epoch fail closed", () => {
  const prefix = { type: "message", role: "developer", content: "fixed developer" };
  const parsed = request([prefix, user("initial"), user("accepted", "Keep order")]);
  const { session } = fixture(parsed);
  emitBatch(session, parsed);
  const candidates = [
    request([prefix, user("initial", "edited"), user("accepted", "Keep order"), result, user("new")]),
    request([prefix, user("accepted", "Keep order"), user("initial"), result, user("new")]),
    request([{ ...prefix, content: "edited developer" }, user("initial"), user("accepted", "Keep order"), result, user("new")]),
    request([user("initial"), prefix, user("accepted", "Keep order"), result, user("new")]),
  ];
  for (const parsed of candidates) expect(session.proveTaskUpdate(parsed, execution).status).toBe("conflict");
  const next = request([prefix, user("initial"), user("accepted", "Keep order"), result, user("new")]);
  expect(session.proveTaskUpdate(next, { ...execution, capabilityIdentity: { epoch: "different" } }).status).toBe("conflict");
  expect(session.proveTaskUpdate(next, { ...execution, executionConfig: { mode: "Zero Risk" } }).status).toBe("conflict");
  expect(session.proveTaskUpdate(parsed, { ...execution, capabilityIdentity: { epoch: "changed-retry" } }).status).toBe("conflict");
  expect(() => session.acceptTaskUpdateRound(parsed, { ...execution, executionConfig: { mode: "Zero Risk" } })).toThrow();
  next.options.reasoning = "xhigh";
  expect(session.proveTaskUpdate(next, execution).status).toBe("conflict");
  expect(session.taskRevision()).toBe(0);
});

test("source round must have observed complete tools and done(tool_use), not merely Broker handoff", () => {
  const { parsed, session } = fixture();
  emitBatch(session, parsed, [req], false);
  const incoming = request([user("initial"), result, user("new")]);
  expect(session.proveTaskUpdate(incoming, execution)).toMatchObject({ status: "conflict", error: { code: "task_update_source_unproven" } });
  expect(() => session.recordTaskUpdateToolBatch(chatGptTurnRoundKey(parsed), [req], 0)).toThrow();
  session.recordTaskUpdateToolBatch(chatGptTurnRoundKey(parsed), [req], 1);
  expect(session.proveTaskUpdate(incoming, execution).status).toBe("eligible");
});

test("known handed-off batch without completed observation proof cannot fall back after an exact request replay", () => {
  const { parsed, session } = fixture();
  const roundKey = chatGptTurnRoundKey(parsed);
  session.setOutstanding([req]);
  session.appendRoundEvents(roundKey, [{ type: "tool_call_start", id: req.callId, name: req.wireName },
    { type: "tool_call_end" }, { type: "done", stopReason: "tool_use", endTurn: false }]);
  expect(session.proveTaskUpdate(parsed, execution).status).toBe("replay");
  const incoming = request([user("initial"), result, user("new")]);
  expect(session.proveTaskUpdate(incoming, execution)).toMatchObject({ status: "conflict", error: { code: "task_update_source_unproven" } });
  expect(() => session.acceptTaskUpdateToolResults(request([user("initial"), result]))).toThrow("known physical tool batch");
  expect(session.outstanding()).toEqual([req]);
  expect(session.driverGeneration()).toBe(0);
  expect(session.taskRevision()).toBe(0);
  session.completeRound(roundKey);
  session.recordTaskUpdateToolBatch(roundKey, [req], 1);
  expect(session.proveTaskUpdate(incoming, execution).status).toBe("eligible");
  const noBatch = fixture();
  expect(noBatch.session.proveTaskUpdate(request([user("initial"), user("new")]), execution)).toMatchObject({ status: "inapplicable", reason: "no_emitted_result_boundary" });
});

test("no source batch permits pure text append and exact accepted initial result history as normal fallback", () => {
  const pure = fixture();
  expect(pure.session.proveTaskUpdate(request([user("initial"), user("new")]), execution)).toEqual({ status: "inapplicable", reason: "no_emitted_result_boundary" });
  const delegation = { type: "function_call_output", name: "send_message_to_thread", output: "Fixed delegated instructions." };
  const history = { ...result, call_id: "accepted-initial-history", output: { content: [{ type: "image", data: "eA==", mimeType: "image/png" }],
    isError: true, structuredContent: { exact: "accepted" }, _meta: { provider: "original" } } };
  const f = fixture(request([delegation, user("initial"), history]));
  const incoming = request([delegation, user("initial"), history, user("new")]);
  expect(f.session.proveTaskUpdate(incoming, execution)).toEqual({ status: "inapplicable", reason: "no_emitted_result_boundary" });
  expect(f.session.acceptTaskUpdateToolResults(request([delegation, user("initial"), history]))).toEqual([]);
  expect(f.session.taskRevision()).toBe(0);
  expect(f.session.driverGeneration()).toBe(0);
  expect(f.cancellations()).toBe(0);
});

for (const failure of ["unknown", "changed-output", "changed-metadata", "duplicate", "wrong-result-type", "invalid-type", "missing-id", "invalid-id"] as const) {
  test(`no source batch rejects ${failure} raw result before fallback or owner changes`, () => {
    const history = { ...result, call_id: "accepted-initial-history" };
    const f = fixture(request([user("initial"), history]));
    let results: unknown[] = [history];
    if (failure === "unknown") results.push({ ...result, call_id: "never-issued" });
    if (failure === "changed-output") results = [{ ...history, output: "changed result" }];
    if (failure === "changed-metadata") results = [{ ...history, _meta: { retained: false } }];
    if (failure === "duplicate") results.push(history);
    if (failure === "wrong-result-type") results = [{ ...history, type: "custom_tool_call_output" }];
    if (failure === "invalid-type") results = [{ ...history, type: "invalid_tool_output" }];
    if (failure === "missing-id") results.push({ type: "function_call_output", output: "unproven" });
    if (failure === "invalid-id") results.push({ type: "function_call_output", call_id: 7, output: "unproven" });
    const incoming = request([user("initial"), ...results, user("new")]);
    expect(f.session.proveTaskUpdate(incoming, execution)).toMatchObject({ status: "conflict", error: {
      code: failure === "missing-id" ? "task_update_source_conflict" : "task_update_source_unproven",
    } });
    expect(() => f.session.acceptTaskUpdateToolResults(incoming)).toThrow();
    expect(f.session.taskRevision()).toBe(0);
    expect(f.session.driverGeneration()).toBe(0);
    expect(f.session.hasPendingTaskUpdate()).toBeFalse();
    expect(f.session.outstanding()).toEqual([]);
    expect(f.session.isTaskUpdateCancelled()).toBeFalse();
    expect(f.session.isActive()).toBeTrue();
    expect(f.cancellations()).toBe(0);
  });
}

for (const failure of ["partial", "duplicate", "unknown", "wrong-type", "mixed-unaccepted"] as const) test(`full batch proof rejects ${failure} before any update/result effect`, () => {
  const { parsed, session } = fixture();
  const other: BrokerToolRequest = { callId: "call-b", wireName: "exec", freeform: true, input: "actual" };
  emitBatch(session, parsed, [req, other]);
  let results: unknown[] = [result, { type: "custom_tool_call_output", call_id: other.callId, output: "second" }];
  if (failure === "partial") results.pop();
  if (failure === "duplicate") results.push(result);
  if (failure === "unknown") results.push({ type: "function_call_output", call_id: "unknown", output: "fake" });
  if (failure === "wrong-type") results[1] = { type: "function_call_output", call_id: other.callId, output: "second" };
  if (failure === "mixed-unaccepted") results.push({ type: "function_call_output", call_id: "old-unissued", output: "old" });
  expect(session.proveTaskUpdate(request([user("initial"), ...results, user("new")]), execution).status).toBe("conflict");
  expect(session.outstanding().map(request => request.callId)).toEqual([req.callId, other.callId]);
  expect(session.taskRevision()).toBe(0);
  expect(session.driverGeneration()).toBe(0);
});

test("exact native request retries are read only; old request without own journal is stale", () => {
  const { parsed, session } = fixture();
  emitBatch(session, parsed);
  const incoming = request([user("initial"), result, user("one"), user("two")], "request-two");
  const proof = eligible(session.proveTaskUpdate(incoming, execution));
  commit(session, proof);
  expect(session.proveTaskUpdate(incoming, execution)).toEqual({ status: "replay", route: proof.route });
  expect(session.proveTaskUpdate(parsed, execution)).toMatchObject({ status: "replay", route: { acceptedRevision: 0, driverGeneration: 0 } });
  expect(session.proveTaskUpdate(request([user("initial"), result, user("one")]), execution).status).toBe("stale");
  const conflict = request([user("initial"), { ...result, output: "changed" }, user("one"), user("two")], "request-two");
  expect(session.proveTaskUpdate(conflict, execution).status).toBe("conflict");
  expect(session.driverGeneration()).toBe(1);
  expect(session.taskRevision()).toBe(2);
});

test("result replay binds complete raw payload including metadata, errors and images", () => {
  const { parsed, session } = fixture();
  emitBatch(session, parsed);
  const raw = { ...result, output: [{ type: "image", data: "eA==", mimeType: "image/png" }], structuredContent: { key: "original" }, isError: true };
  const first = request([user("initial"), raw, user("one")]);
  commit(session, eligible(session.proveTaskUpdate(first, execution)));
  const replay = request([user("initial"), raw, user("one"), user("two")]);
  expect(eligible(session.proveTaskUpdate(replay, execution)).mode).toBe("replay");
  for (const changed of [{ ...raw, _meta: { retained: false } }, { ...raw, isError: false }, { ...raw, structuredContent: { key: "changed" } }]) {
    expect(session.proveTaskUpdate(request([user("initial"), changed, user("one"), user("two")]), execution).status).toBe("conflict");
  }
});

test("previous valid result history survives new batches and ordinary results receive distinct round journals", () => {
  const history = { type: "function_call_output", call_id: "completed-before-session", output: "true history" };
  const parsed = request([history, user("initial")]);
  const { session } = fixture(parsed);
  emitBatch(session, parsed);
  const ordinary = request([history, user("initial"), result]);
  const round = session.acceptTaskUpdateRound(ordinary, execution)!;
  expect(round.driverGeneration).toBe(0);
  expect(round.roundKey).not.toBe(chatGptTurnRoundKey(parsed));
  expect(session.acceptTaskUpdateToolResults(ordinary).map(message => message.toolCallId)).toEqual([req.callId]);
  session.markResultDelivered(req.callId);
  const second: BrokerToolRequest = { ...req, callId: "second" };
  emitBatch(session, ordinary, [second]);
  const incoming = request([history, user("initial"), result, { ...result, call_id: "second" }, user("new")]);
  expect(eligible(session.proveTaskUpdate(incoming, execution)).batch.requests.map(request => request.callId)).toEqual(["second"]);
  const changedHistory = structuredClone(incoming);
  (changedHistory._rawBody as { input: any[] }).input[0].output = "changed history";
  expect(session.proveTaskUpdate(changedHistory, execution).status).toBe("conflict");
});

test("unknown and not_found preserve prepared isolation; same transfer recovery registers once", async () => {
  const { parsed, session } = fixture();
  emitBatch(session, parsed);
  const proof = eligible(session.proveTaskUpdate(request([user("initial"), result, user("new")]), execution));
  const change = session.waitForDriverChange(0);
  const prepared = session.prepareTaskUpdate(proof, "uncertain", "exact-payload");
  await change;
  expect(Object.isFrozen(prepared)).toBeTrue();
  expect(() => session.assertDriverGeneration(0)).toThrow("awaiting an authoritative conclusion");
  expect(session.finishTaskUpdateTransfer({ status: "not_found", transferId: "uncertain" })).toBe("unknown");
  expect(session.finishTaskUpdateTransfer({ status: "unknown", transferId: "uncertain" })).toBe("unknown");
  expect(session.prepareTaskUpdate(proof, "uncertain", "exact-payload")).toBe(prepared);
  expect(() => session.prepareTaskUpdate(proof, "another-id", "exact-payload")).toThrow();
  const outcome: TaskUpdateTransferOutcome = { status: "committed", transferId: "uncertain", state: state(1, 1), batchFingerprint: proof.batch.batchFingerprint };
  expect(session.finishTaskUpdateTransfer(outcome)).toBe("committed");
  expect(session.finishTaskUpdateTransfer(outcome)).toBe("committed");
  expect(session.hasPendingTaskUpdate()).toBeFalse();
  expect(session.driverGeneration()).toBe(1);
  expect(() => session.assertDriverGeneration(0)).toThrow("no longer owns");
});

test("terminal rejection restores only the original valid owner and never revives cancellation or newer generation", () => {
  for (const scenario of ["original", "cancelled", "new-generation", "final-output"] as const) {
    const { parsed, session } = fixture();
    const sourceRound = emitBatch(session, parsed);
    const before = session.roundEvents(sourceRound);
    const proof = eligible(session.proveTaskUpdate(request([user("initial"), result, user("new")]), execution));
    session.prepareTaskUpdate(proof, "rejected", "exact");
    const authoritative = state(0, scenario === "new-generation" ? 1 : 0);
    if (scenario === "cancelled") session.cancel(new Error("physical cancellation"));
    if (scenario === "final-output") authoritative.finalOutputRevision = 0;
    const refusal: TaskUpdateTransferOutcome = { status: "not_committed", transferId: "rejected", code: "capacity", message: "full" };
    expect(session.finishTaskUpdateTransfer(refusal, { ownerValid: true, state: authoritative })).toBe(scenario === "original" ? "restored" : "closed");
    expect(session.roundEvents(sourceRound)).toEqual(before);
    expect(session.outstanding()).toHaveLength(1);
    if (scenario === "original") session.assertDriverGeneration(0);
    else expect(() => session.assertDriverGeneration(0)).toThrow();
    expect(() => session.finishTaskUpdateTransfer({ status: "committed", transferId: "rejected", state: state(1, 1), batchFingerprint: proof.batch.batchFingerprint })).toThrow("immutable");
  }
});

test("continuous append wakes an active old observer and journals one incomplete after commit only", async () => {
  const { parsed, session } = fixture();
  const originalRound = emitBatch(session, parsed);
  const one = request([user("initial"), result, user("one")]);
  commit(session, eligible(session.proveTaskUpdate(one, execution)), "first");
  const round = chatGptTurnRoundKey(one);
  const release = session.enterTaskUpdateObserver(round, 1);
  session.appendRoundEvents(round, [{ type: "text_delta", phase: "commentary", text: "own commentary" }], 1);
  let driverReleased = false;
  const long = session.runExclusive(async () => { await session.waitForDriverChange(1); driverReleased = true; });
  await Promise.resolve();
  const two = request([user("initial"), result, user("one"), user("two")]);
  const proof = eligible(session.proveTaskUpdate(two, execution));
  session.prepareTaskUpdate(proof, "second", "same-second");
  await long;
  expect(driverReleased).toBeTrue();
  expect(session.roundHasTerminalEvent(round)).toBeFalse();
  const outcome: TaskUpdateTransferOutcome = { status: "committed", transferId: "second", state: state(2, 2), batchFingerprint: proof.batch.batchFingerprint };
  session.finishTaskUpdateTransfer(outcome);
  session.finishTaskUpdateTransfer(outcome);
  expect(session.roundEvents(round)).toEqual([{ type: "text_delta", phase: "commentary", text: "own commentary" },
    { type: "incomplete", reason: "task_update_handoff", retryable: false, endTurn: false }]);
  expect(session.roundHasTerminalEvent(round)).toBeTrue();
  expect(session.roundCompleted(round)).toBeTrue();
  expect(session.roundEvents(originalRound).at(-1)).toMatchObject({ type: "done", stopReason: "tool_use" });
  expect(session.roundEvents(chatGptTurnRoundKey(two))).toEqual([]);
  release();
});

test("physical retirement waits for independent prepared transfer and current observer, once", async () => {
  const f = fixture();
  emitBatch(f.session, f.parsed);
  const proof = eligible(f.session.proveTaskUpdate(request([user("initial"), result, user("one")]), execution));
  f.session.prepareTaskUpdate(proof, "physical-race", "physical-race");
  f.finishBrowser("done");
  f.settlePhysical();
  await f.session.physicalSettlement;
  await Promise.resolve();
  expect(f.retirements()).toBe(0);
  f.session.finishTaskUpdateTransfer({ status: "committed", transferId: "physical-race", state: state(1, 1), batchFingerprint: proof.batch.batchFingerprint });
  const release = f.session.enterTaskUpdateObserver(proof.route.roundKey, 1);
  await Promise.resolve();
  expect(f.retirements()).toBe(0);
  release();
  await f.session.waitForLogicalSettlement();
  await f.retirement;
  expect(f.retirements()).toBe(1);
});

test("logical routes reuse one physical registry slot, keep exact latest compaction source and clean once", async () => {
  const parsed = request();
  const f = fixture(parsed);
  const sessions = new ChatGptTurnSessions(undefined, 1);
  const oldKey = `namespace:${chatGptTurnExecutionKey(parsed)}`;
  const physical = sessions.getOrCreate(oldKey, () => f.runtime, "trace", "owner", "turn", "thread");
  physical.initializeTaskUpdates(parsed, execution);
  emitBatch(physical, parsed);
  const incoming = request([user("initial"), result, user("one")]);
  const proof = eligible(physical.proveTaskUpdate(incoming, execution));
  commit(physical, proof);
  const nextKey = `namespace:${proof.route.executionKey}`;
  sessions.registerTaskUpdateRoute(nextKey, physical);
  sessions.registerTaskUpdateRoute(nextKey, physical);
  expect(sessions.find(nextKey)).toBe(physical);
  expect(sessions.findTaskUpdateOwner("thread", "turn", "owner")).toBe(physical);
  expect(sessions.findTaskUpdateSource(oldKey)).toBeUndefined();
  expect(sessions.findTaskUpdateSource(nextKey)).toBe(physical);
  expect(sessions.activeCount()).toBe(1);
  expect(sessions.clear()).toBe(1);
  expect(f.cancellations()).toBe(1);
  expect(sessions.find(nextKey)).toBeUndefined();
  f.settlePhysical();
  await physical.physicalSettlement;
});

test("text feed retains the candidate captured before later driver changes", () => {
  const feed = new ChatGptTextFeed();
  const context = { taskRevision: 1, expectedDriverGeneration: 1 };
  feed.push("old candidate", context);
  context.taskRevision = 2;
  context.expectedDriverGeneration = 2;
  expect(feed.drainWithContext()).toEqual([{ text: "old candidate", context: { taskRevision: 1, expectedDriverGeneration: 1 } }]);
  feed.push("compatibility");
  expect(feed.drain()).toEqual(["compatibility"]);
  expect(feed.value()).toBe("old candidatecompatibility");
});

test("older accepted request without its own observer journal remains stale after a newer append", () => {
  const { parsed, session } = fixture();
  emitBatch(session, parsed);
  const first = request([user("initial"), result, user("one")]);
  commit(session, eligible(session.proveTaskUpdate(first, execution)), "first-unobserved");
  const second = request([user("initial"), result, user("one"), user("two")]);
  commit(session, eligible(session.proveTaskUpdate(second, execution)), "second-unobserved");
  expect(session.proveTaskUpdate(first, execution).status).toBe("stale");
  expect(() => session.acceptTaskUpdateRound(first, execution)).toThrow("no own retained output journal");
  expect(session.roundEvents(chatGptTurnRoundKey(first))).toEqual([]);
  expect(session.taskRevision()).toBe(2);
});

test("pending reservation lifecycle hold protects physical retirement without freezing generation", async () => {
  const f = fixture();
  const release = f.session.retainTaskUpdateTransaction();
  f.session.assertDriverGeneration(0);
  f.finishBrowser("done");
  f.settlePhysical();
  await f.session.physicalSettlement;
  await Promise.resolve();
  expect(f.retirements()).toBe(0);
  release();
  release();
  await f.session.waitForLogicalSettlement();
  await f.retirement;
  expect(f.retirements()).toBe(1);
});

test("logical request budget rejects before a prepared barrier or new revision exists", () => {
  const { parsed, session } = fixture();
  emitBatch(session, parsed);
  for (let index = 1; index < 128; index++) session.acceptTaskUpdateRound(request([user("initial"), result], `round-${index}`), execution);
  const proof = eligible(session.proveTaskUpdate(request([user("initial"), result, user("new")]), execution));
  expect(() => session.prepareTaskUpdate(proof, "over-capacity", "unchanged-payload")).toThrow("capacity");
  expect(session.hasPendingTaskUpdate()).toBeFalse();
  session.assertDriverGeneration(0);
  expect(session.taskRevision()).toBe(0);
});

test("new native multimodal user suffix keeps fallback eligibility without hiding invalid batch or prefix edits", () => {
  const { parsed, session } = fixture();
  emitBatch(session, parsed);
  const image = { ...user("new-image"), content: [{ type: "input_image", image_url: "data:image/png;base64,eA==" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn", content_item_kinds: ["user.image"] } };
  expect(session.proveTaskUpdate(request([user("initial"), result, image]), execution)).toMatchObject({ status: "inapplicable", reason: "multimodal_user_update" });
  expect(session.proveTaskUpdate(request([user("initial", "edited"), result, image]), execution).status).toBe("conflict");
  expect(session.proveTaskUpdate(request([user("initial"), image]), execution).status).toBe("conflict");
  expect(session.taskRevision()).toBe(0);
  expect(session.driverGeneration()).toBe(0);
});

test("a rejected continuous append resumes only its paused observer; late old cleanup cannot cancel the new driver", () => {
  const f = fixture();
  emitBatch(f.session, f.parsed);
  const first = request([user("initial"), result, user("one")]);
  commit(f.session, eligible(f.session.proveTaskUpdate(first, execution)), "first-observer");
  const roundKey = chatGptTurnRoundKey(first);
  const release = f.session.enterTaskUpdateObserver(roundKey, 1);
  f.session.appendRoundEvents(roundKey, [{ type: "thinking_delta", thinking: "own reasoning" }], 1);
  const second = request([user("initial"), result, user("one"), user("two")]);
  const proof = eligible(f.session.proveTaskUpdate(second, execution));
  f.session.prepareTaskUpdate(proof, "rejected-observer", "same-payload");
  expect(f.session.finishTaskUpdateTransfer({ status: "not_committed", transferId: "rejected-observer", code: "capacity", message: "full" },
    { ownerValid: true, state: state(1, 1) })).toBe("restored");
  f.session.assertDriverGeneration(1);
  expect(f.session.roundHasTerminalEvent(roundKey)).toBeFalse();
  expect(f.session.roundEvents(roundKey)).toEqual([{ type: "thinking_delta", thinking: "own reasoning" }]);
  commit(f.session, eligible(f.session.proveTaskUpdate(second, execution)), "accepted-observer");
  expect(() => f.session.cancelDriver(1, new Error("late abort"))).toThrow("no longer owns");
  expect(f.cancellations()).toBe(0);
  f.session.assertDriverGeneration(2);
  release();
});

test("trusted stop releases a frozen observer and owner retirement while retaining the exact unknown transfer", async () => {
  const f = fixture();
  const sessions = new ChatGptTurnSessions(undefined, 1);
  const key = `namespace:${chatGptTurnExecutionKey(f.parsed)}`;
  const source = sessions.getOrCreate(key, () => f.runtime, "trace", "owner", "turn", "thread");
  source.initializeTaskUpdates(f.parsed, execution);
  const sourceRound = emitBatch(source, f.parsed);
  const sourceEvents = source.roundEvents(sourceRound);
  const first = request([user("initial"), result, user("one")]);
  commit(source, eligible(source.proveTaskUpdate(first, execution)), "before-stop");
  const observingRound = chatGptTurnRoundKey(first);
  const releaseObserver = source.enterTaskUpdateObserver(observingRound, 1);
  source.appendRoundEvents(observingRound, [{ type: "text_delta", text: "own commentary", phase: "commentary" }], 1);
  const proof = eligible(source.proveTaskUpdate(request([user("initial"), result, user("one"), user("two")]), execution));
  const releaseTransaction = source.retainTaskUpdateTransaction();
  const prepared = source.prepareTaskUpdate(proof, "stopped-unknown", "immutable-payload");
  let observerStarted!: () => void;
  const started = new Promise<void>(resolve => { observerStarted = resolve; });
  const observer = source.runExclusive(async () => {
    observerStarted();
    try {
      await source.waitForTaskUpdatePreparation();
      source.assertDriverGeneration(1);
    } finally { releaseObserver(); }
  });
  await started;
  const stopped = sessions.cancelNativeTurn("thread", "turn", new Error("trusted physical stop"));
  expect(stopped.cancelled).toBe(1);
  await expect(observer).rejects.toMatchObject({ code: "task_update_driver_stale" });
  f.finishBrowser("physical task stopped");
  f.settlePhysical();
  await stopped.settlement;
  await f.retirement;
  expect(f.retirements()).toBe(1);
  expect(f.cancellations()).toBe(1);
  expect(source.preparedTaskUpdateRecord()).toBe(prepared);
  expect(source.hasPendingTaskUpdate()).toBeTrue();
  expect(source.finishTaskUpdateTransfer({ status: "not_found", transferId: "stopped-unknown" })).toBe("unknown");
  expect(source.isTaskUpdateCancelled()).toBeTrue();
  expect(sessions.findTaskUpdateOwner("thread", "turn", "owner")).toBeUndefined();
  expect(source.roundEvents(sourceRound)).toEqual(sourceEvents);
  expect(source.roundHasTerminalEvent(observingRound)).toBeFalse();
  await source.waitForDriverChange(1);
  let replacementStarts = 0;
  const replacement = await sessions.getOrCreateAfterOwnerRetirement("replacement", "owner", () => {
    replacementStarts++;
    return { ...f.runtime, retireCapability: undefined };
  }, "new-trace", undefined, "new-turn", "thread");
  expect(replacement).not.toBe(source);
  expect(replacementStarts).toBe(1);

  // The Broker may have committed before cancellation even though its receipt was lost.
  // Register that exact historical fact without reviving the canceled execution or journal.
  const receipt: TaskUpdateTransferOutcome = { status: "committed", transferId: "stopped-unknown",
    state: state(2, 2), batchFingerprint: proof.batch.batchFingerprint };
  expect(source.finishTaskUpdateTransfer(receipt)).toBe("committed");
  expect(source.finishTaskUpdateTransfer(receipt)).toBe("committed");
  expect(source.taskRevision()).toBe(2);
  expect(source.driverGeneration()).toBe(2);
  expect(() => source.assertDriverGeneration(2)).toThrow("no longer owns");
  expect(source.roundHasTerminalEvent(observingRound)).toBeFalse();
  expect(() => source.finishTaskUpdateTransfer({ status: "not_committed", transferId: "stopped-unknown", code: "stopped", message: "stopped" })).toThrow("immutable");
  releaseTransaction();
  releaseTransaction();
  await source.waitForLogicalSettlement();
  expect(f.retirements()).toBe(1);
  expect(f.cancellations()).toBe(1);
});

test("trusted stop releases a pre-reservation RPC hold without fabricating a transfer or restoring a refused driver", async () => {
  const f = fixture();
  const release = f.session.retainTaskUpdateTransaction();
  const change = f.session.waitForDriverChange(0);
  f.session.cancel(new Error("trusted physical stop before reservation receipt"));
  await change;
  f.finishBrowser("stopped");
  f.settlePhysical();
  await f.session.physicalSettlement;
  await f.session.waitForLogicalSettlement();
  await f.retirement;
  expect(f.session.preparedTaskUpdateRecord()).toBeUndefined();
  expect(() => f.session.retainTaskUpdateTransaction()).toThrow("cannot admit");
  expect(() => f.session.assertDriverGeneration(0)).toThrow("no longer owns");
  release();
  release();
  expect(f.retirements()).toBe(1);

  const preparedFixture = fixture();
  emitBatch(preparedFixture.session, preparedFixture.parsed);
  const proof = eligible(preparedFixture.session.proveTaskUpdate(request([user("initial"), result, user("new")]), execution));
  preparedFixture.session.prepareTaskUpdate(proof, "stopped-refusal", "exact");
  preparedFixture.session.cancel(new Error("trusted stop"));
  preparedFixture.finishBrowser("stopped");
  preparedFixture.settlePhysical();
  await preparedFixture.session.physicalSettlement;
  await preparedFixture.session.waitForLogicalSettlement();
  await preparedFixture.retirement;
  const refusal: TaskUpdateTransferOutcome = { status: "not_committed", transferId: "stopped-refusal", code: "revoked", message: "revoked" };
  expect(preparedFixture.session.finishTaskUpdateTransfer(refusal, { ownerValid: true, state: state(0, 0) })).toBe("closed");
  expect(preparedFixture.session.finishTaskUpdateTransfer(refusal, { ownerValid: true, state: state(0, 0) })).toBe("closed");
  expect(preparedFixture.session.taskRevision()).toBe(0);
  expect(preparedFixture.session.outstanding()).toHaveLength(1);
  expect(() => preparedFixture.session.assertDriverGeneration(0)).toThrow("no longer owns");
});

test("explicit compaction preservation replays only the canonical completed source and trusted re-ID", async () => {
  const developer = { type: "message", id: "developer", role: "developer", content: "fixed requirements" };
  const parsed = request([developer, user("initial")]);
  const f = fixture(parsed, "retained-conversation");
  const sessions = new ChatGptTurnSessions();
  const key = `namespace:${chatGptTurnExecutionKey(parsed)}`;
  const source = sessions.getOrCreate(key, () => f.runtime, "trace", "owner", "turn", "thread");
  source.initializeTaskUpdates(parsed, execution);
  const roundKey = chatGptTurnRoundKey(parsed);
  const finalEvents: AdapterEvent[] = [{ type: "text_delta", text: "completed answer" }, { type: "done", stopReason: "stop", endTurn: true }];
  source.appendRoundEvents(roundKey, finalEvents);
  source.completeRound(roundKey);
  source.runtime.taskUpdates!.outputReceipt = { taskRevision: 0, driverGeneration: 0, kind: "completed" };
  f.finishBrowser("completed answer");
  f.settlePhysical();
  await Promise.all([source.browserOutcome, source.physicalSettlement]);
  const summary = { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nCompacted history.` }] };
  const compacted = request([developer, user("initial"), summary], "preserved-request");
  expect(source.preservedCompactionFinalReplay(compacted, execution, key)).toBeUndefined();
  await sessions.retireConversationPreservingFinalResponse("retained-conversation", source, key);
  expect(source.preservedCompactionFinalReplay(compacted, execution, key)).toEqual({
    roundKey, terminalJournal: true, outputReceipt: { taskRevision: 0, driverGeneration: 0, kind: "completed" },
  });
  const reidentified = request([{ ...developer, id: "re-id-developer" }, user("re-id-initial"), summary]);
  reidentified._chatGptMessageIdAliases = { "re-id-developer": "developer", "re-id-initial": "initial" };
  expect(source.preservedCompactionFinalReplay(reidentified, execution, key)?.roundKey).toBe(roundKey);
  expect(source.preservedCompactionFinalReplay(parsed, execution, key)).toBeUndefined();
  for (const invalid of [
    request([{ ...developer, content: "changed requirements" }, user("initial"), summary]),
    request([developer, user("initial", "changed user source"), summary]),
    request([developer, user("initial"), { type: "function_call_output", call_id: "unknown", output: "invented" }, summary]),
    request([developer, user("initial"), { ...summary, content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nChanged request payload.` }] }], "preserved-request"),
  ]) expect(() => source.preservedCompactionFinalReplay(invalid, execution, key)).toThrow();
  expect(() => source.preservedCompactionFinalReplay(compacted, { ...execution, executionConfig: { mode: "changed" } }, key)).toThrow();
  expect(source.roundEvents(roundKey)).toEqual(finalEvents);
  expect(source.taskRevision()).toBe(0);
  expect(source.driverGeneration()).toBe(0);
  expect(f.cancellations()).toBe(0);
});

test("completed round recovery requires its accepted route and matching completed receipt without reopening driver writes", async () => {
  const f = fixture();
  const key = chatGptTurnRoundKey(f.parsed);
  const context = { expectedDriverGeneration: 0, taskRevision: 0 };
  await f.session.runExclusive(async () => {});
  f.finishBrowser("completed answer");
  f.settlePhysical();
  await Promise.all([f.session.browserOutcome, f.session.physicalSettlement, f.retirement]);
  expect(() => f.session.assertDriverGeneration(0)).toThrow();
  expect(() => f.session.assertCompletedTaskUpdateRound(key, context)).toThrow();
  for (const receipt of [
    { kind: "output_started" as const, taskRevision: 0, driverGeneration: 0 },
    { kind: "completed" as const, taskRevision: 1, driverGeneration: 0 },
    { kind: "completed" as const, taskRevision: 0, driverGeneration: 1 },
  ]) {
    f.runtime.taskUpdates.outputReceipt = receipt;
    expect(() => f.session.assertCompletedTaskUpdateRound(key, context)).toThrow();
  }
  f.runtime.taskUpdates.outputReceipt = { kind: "completed", taskRevision: 0, driverGeneration: 0 };
  expect(() => f.session.assertCompletedTaskUpdateRound("another-round", context)).toThrow();
  expect(() => f.session.assertCompletedTaskUpdateRound(key, { ...context, taskRevision: 1 })).toThrow();
  expect(() => f.session.assertCompletedTaskUpdateRound(key, context)).not.toThrow();
  expect(() => f.session.assertDriverGeneration(0)).toThrow();
  f.session.cancel();
  expect(() => f.session.assertCompletedTaskUpdateRound(key, context)).toThrow();
  expect(f.retirements()).toBe(1);
});

test("compaction final racing native registration gets one read only final route without altering a tool round", async () => {
  const f = fixture(request(), "retained-conversation");
  const sessions = new ChatGptTurnSessions();
  const key = `namespace:${chatGptTurnExecutionKey(f.parsed)}`;
  const source = sessions.getOrCreate(key, () => f.runtime, "trace", "owner", "turn", "thread");
  source.initializeTaskUpdates(f.parsed, execution);
  const toolRound = emitBatch(source, f.parsed);
  const before = source.roundEvents(toolRound);
  source.acceptTaskUpdateToolResults(request([user("initial"), result]));
  source.markResultDelivered(req.callId);
  source.runtime.taskUpdates!.outputReceipt = { taskRevision: 0, driverGeneration: 0, kind: "completed" };
  f.finishBrowser("settled answer before registration");
  f.settlePhysical();
  await Promise.all([source.browserOutcome, source.physicalSettlement]);
  await sessions.retireConversationPreservingFinalResponse("retained-conversation", source, key);
  const compacted = request([user("initial"), result, { type: "message", role: "user", content: `${SUMMARY_PREFIX}\nHistory compacted.` }]);
  const replay = source.preservedCompactionFinalReplay(compacted, execution, key)!;
  expect(replay.terminalJournal).toBeFalse();
  expect(replay.roundKey).not.toBe(toolRound);
  source.appendRoundEvents(replay.roundKey, [{ type: "text_delta", text: "settled answer before registration" }, { type: "done", stopReason: "stop", endTurn: true }]);
  source.completeRound(replay.roundKey);
  expect(source.preservedCompactionFinalReplay(compacted, execution, key)).toMatchObject({ roundKey: replay.roundKey, terminalJournal: true });
  expect(source.roundEvents(toolRound)).toEqual(before);
  expect(() => source.preservedCompactionFinalReplay(request([user("initial"), { ...result, output: "changed" }, { type: "message", role: "user", content: `${SUMMARY_PREFIX}\nHistory compacted.` }]), execution, key)).toThrow();
  expect(f.cancellations()).toBe(0);
});

test("ordinary journal exhaustion retains one bounded replayable capacity error and never exceeds the total budget", () => {
  const f = fixture();
  const roundKey = chatGptTurnRoundKey(f.parsed);
  expect(storage(f.session).errorRounds).toBe(1);
  fillOrdinaryJournal(f.session, roundKey);
  expect(storage(f.session).used).toBe(TASK_UPDATE_SESSION_JOURNAL_BYTES);
  expect(() => f.session.appendRoundEvents(roundKey, [{ type: "text_delta", text: "overflow" }], 0)).toThrow("capacity");
  expect(() => f.session.appendRoundReasoning(roundKey, ["overflow"])).toThrow("capacity");
  const originalError = { type: "error" as const, message: "Full provider failure details", code: "provider_failed", status: 502, retryable: true };
  const before = storage(f.session);
  const actual = f.session.appendRoundError(roundKey, originalError);
  expect(actual).toMatchObject({ type: "error", code: "task_update_capacity", retryable: false });
  expect(Buffer.byteLength(JSON.stringify([actual]))).toBe(TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES);
  expect(storage(f.session).journal - before.journal).toBe(TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES);
  expect(storage(f.session).used).toBe(TASK_UPDATE_SESSION_JOURNAL_BYTES);
  f.session.completeRound(roundKey);
  expect(f.session.roundEvents(roundKey).at(-1)).toEqual(actual);
  expect(f.session.roundCompleted(roundKey)).toBeTrue();
  expect(storage(f.session).used).toBe(TASK_UPDATE_SESSION_JOURNAL_BYTES);
  expect(() => f.session.appendRoundError(roundKey, originalError)).toThrow("completed");
  expect(() => f.session.appendRoundEvents(roundKey, [originalError])).toThrow("completed");
  expect(() => f.session.appendRoundError("unadmitted-round", originalError)).toThrow("capacity");
  expect(storage(f.session).used).toBe(TASK_UPDATE_SESSION_JOURNAL_BYTES);
});

test("ordinary error terminals preserve exact details and completed rounds release only unused reserve bytes", () => {
  const f = fixture();
  const roundKey = chatGptTurnRoundKey(f.parsed);
  const error = { type: "error" as const, message: "Exact provider failure", code: "provider_failed", status: 502,
    retryable: true, usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
  const before = storage(f.session);
  expect(f.session.appendRoundError(roundKey, error)).toEqual(error);
  const charged = Buffer.byteLength(JSON.stringify([error]));
  expect(storage(f.session).journal - before.journal).toBe(charged);
  f.session.completeRound(roundKey);
  expect(storage(f.session).used).toBe(before.used + charged - TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES);
  expect(f.session.roundEvents(roundKey)).toEqual([error]);
  expect(storage(f.session).errorRounds).toBe(0);
});

test("source initialization and new ordinary round admission reserve their own capacity error terminal", () => {
  const empty = user("initial", "");
  const overhead = Buffer.byteLength(JSON.stringify([empty]));
  const rejected = request([user("initial", "x".repeat(TASK_UPDATE_SESSION_JOURNAL_BYTES - overhead - TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES + 1))]);
  const runtime = fixture().runtime;
  const source = new ChatGptTurnSession(runtime, "source", "owner", "turn", "thread");
  expect(() => source.initializeTaskUpdates(rejected, execution)).toThrow("capacity");
  expect(source.taskUpdatesEnabled()).toBeFalse();
  const admitted = request([user("initial", "x".repeat(TASK_UPDATE_SESSION_JOURNAL_BYTES - overhead - TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES))]);
  expect(source.initializeTaskUpdates(admitted, execution)).toBeTrue();
  expect(storage(source).used).toBe(TASK_UPDATE_SESSION_JOURNAL_BYTES);
  const terminal = source.appendRoundError(chatGptTurnRoundKey(admitted), { type: "error", message: "source is full" });
  source.completeRound(chatGptTurnRoundKey(admitted));
  expect(terminal.code).toBe("task_update_capacity");
  expect(storage(source).used).toBe(TASK_UPDATE_SESSION_JOURNAL_BYTES);

  const f = fixture();
  const initialRound = chatGptTurnRoundKey(f.parsed);
  fillOrdinaryJournal(f.session, initialRound);
  const continuation = request([user("initial"), { type: "message", role: "assistant", content: "ordinary request continuation" }]);
  expect(() => f.session.acceptTaskUpdateRound(continuation, execution)).toThrow("error-terminal capacity");
  expect(storage(f.session).errorRounds).toBe(1);
  expect(f.session.taskUpdateRoute(chatGptTurnExecutionKey(f.parsed))?.roundKey).toBe(initialRound);
  expect(f.session.taskRevision()).toBe(0);
  expect(f.session.driverGeneration()).toBe(0);
  expect(f.session.appendRoundError(initialRound, { type: "error", message: "admission exhausted" }).code).toBe("task_update_capacity");
});

test("prepared transfer reserves source and handoff bytes separately from both rounds' capacity terminal", () => {
  const f = fixture();
  emitBatch(f.session, f.parsed);
  const first = request([user("initial"), result, user("one")]);
  commit(f.session, eligible(f.session.proveTaskUpdate(first, execution)), "capacity-first");
  const roundKey = chatGptTurnRoundKey(first);
  const release = f.session.enterTaskUpdateObserver(roundKey, 1);
  f.session.appendRoundEvents(roundKey, [{ type: "text_delta", text: "current observer" }], 1);
  const second = request([user("initial"), result, user("one"), user("two")]);
  const proof = eligible(f.session.proveTaskUpdate(second, execution));
  const before = storage(f.session);
  f.session.prepareTaskUpdate(proof, "capacity-handoff", "immutable");
  expect(storage(f.session).errorRounds).toBe(before.errorRounds + 1);
  expect(storage(f.session).used).toBeGreaterThan(before.used + TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES);
  fillOrdinaryJournal(f.session, roundKey);
  expect(storage(f.session).used).toBe(TASK_UPDATE_SESSION_JOURNAL_BYTES);
  expect(() => f.session.appendRoundEvents(roundKey, [{ type: "text_delta", text: "overflow" }])).toThrow("capacity");
  const beforeCommit = storage(f.session);
  const receipt: TaskUpdateTransferOutcome = { status: "committed", transferId: "capacity-handoff",
    state: state(2, 2), batchFingerprint: proof.batch.batchFingerprint };
  expect(f.session.finishTaskUpdateTransfer(receipt)).toBe("committed");
  const handoff = f.session.roundEvents(roundKey).at(-1)!;
  expect(handoff).toMatchObject({ type: "incomplete", reason: "task_update_handoff" });
  expect(storage(f.session).journal - beforeCommit.journal).toBe(Buffer.byteLength(JSON.stringify([handoff])));
  expect(storage(f.session).used).toBeLessThanOrEqual(TASK_UPDATE_SESSION_JOURNAL_BYTES);
  expect(storage(f.session).errorRounds).toBe(1);
  expect(() => f.session.appendRoundEvents(roundKey, [{ type: "text_delta", text: "late stale write" }], 1)).toThrow("no longer owns");
  release();

  const rejected = fixture();
  emitBatch(rejected.session, rejected.parsed);
  const next = request([user("initial"), result, user("new")]);
  const incoming = eligible(rejected.session.proveTaskUpdate(next, execution));
  const admission = rejected.session.acceptTaskUpdateRound(request([user("initial"), result]), execution)!;
  fillOrdinaryJournal(rejected.session, admission.roundKey);
  expect(() => rejected.session.prepareTaskUpdate(incoming, "cannot-reserve", "exact")).toThrow("capacity");
  expect(rejected.session.hasPendingTaskUpdate()).toBeFalse();
  expect(storage(rejected.session).errorRounds).toBe(1);
  expect(rejected.session.driverGeneration()).toBe(0);
  expect(rejected.session.taskRevision()).toBe(0);
  expect(rejected.session.appendRoundError(admission.roundKey, { type: "error", message: "prepare exhausted" }).code).toBe("task_update_capacity");
});
