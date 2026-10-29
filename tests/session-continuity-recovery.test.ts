import { CONTEXT_PROTOCOL_VERSION } from "../src/adapters/chatgpt-web/context-runtime";
import { ContinuityRecoveryStore, continuityProcessInstance, continuityProcessInstanceStatus } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { evictOptionalRecoveryResults, recordRecoveryAppend, recoveryDigest, recoveryIdentity, recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import * as recoveryRuntime from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import * as continuityInput from "../src/adapters/chatgpt-web/continuity-input";
import { afterEach, expect, spyOn } from "bun:test";
import { $ } from "bun";
import { harmlessContinuityCommand } from "./helpers/continuity-command";
import { OPENAI_ACCESS } from "../src/api-access";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { bindContinuityRequestScope } from "../src/adapters/chatgpt-web/continuity-request";
import { leaveContinuityMode } from "../src/adapters/chatgpt-web/continuity-lifecycle";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter } from "./helpers/chatgpt-web-adapter";
import { chatGptContinuityInstructionPayloadDigest, continuityInstructionIdentity, chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, RemoteTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultConfig } from "../src/config";
import * as configuration from "../src/config";
import { CONTINUITY_EXECUTION_FENCING_FEATURE } from "../src/launcher-browser-host";
import { encodeCompactionSummary } from "../src/responses/compaction";
import { startServer } from "../src/server";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import { performanceTest } from "./helpers/performance-test";
import { createSessionContinuityFixtures, launcherRecovery, launcherLease, launcherAuthority, recordedCall, currentRecordedCall, taskEnvelope } from "./helpers/session-continuity-fixture";

const test = performanceTest(import.meta.path);
const { cleanups, disposeTestFixtures, fixture } = createSessionContinuityFixtures(import.meta.path);
afterEach(disposeTestFixtures);

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} leaving continuity clears its page and a current request starts again`, async () => {
  const f = fixture(manual), first = f.request();
  await f.run(first);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), old = store.get(thread)!;
  await Promise.all([leaveContinuityMode(f.statePath, f.threadId), leaveContinuityMode(f.statePath, f.threadId)]);
  expect(f.pages.size).toBe(0);
  expect(store.get(thread)).toBeUndefined();
  expect(continuityBindingsFor(f.statePath).observed(thread)).toBeUndefined();
  expect((await f.run(structuredClone(first))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const current = store.get(thread)!;
  expect(current.works[old.currentWorkId!]).toBeUndefined();
  expect(current.epoch).not.toBe(old.epoch);
  expect(f.submissions).toHaveLength(2);
});

test("mode exit refuses an active manual owner without cancelling its authorized work", async () => {
  const f = fixture(true);
  f.controls.deferCompletion = true;
  const first = f.request();
  const adapter = f.adapter();
  await adapter.preflight!(first, { headers: new Headers() });
  const running = adapter.runTurn!(first, { headers: new Headers() }, () => {});
  void running.catch(() => {});
  while (!f.controls.started) await Bun.sleep(1);
  try {
    expect(() => leaveContinuityMode(f.statePath, f.threadId))
      .toThrow("Finish or explicitly cancel the current continuity work");
    expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
    expect(f.pages.size).toBe(1);
  } finally {
    f.broker.completeSafeTurn(f.controls.safeToken, "Completed response 1.");
    await running;
  }
  await leaveContinuityMode(f.statePath, f.threadId);
  expect(f.registrations.get(continuityDigest(f.threadId))).toBeUndefined();
  expect(f.pages.size).toBe(0);
});

test("page lifecycle regression: an interrupted closed response starts the same instruction in a new generation", async () => {
  const f = fixture();
  f.controls.failAfterSendOnce = true;
  const original = f.request();
  const failed = await f.run(original);
  expect(failed.at(-1)).toMatchObject({ type: "error", code: "chatgpt_submitted_turn_failed" });
  const retry = await f.run(f.request());
  expect(retry.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.claim.recovery!.epoch).not.toBe(f.submissions[0]!.claim.recovery!.epoch);
  expect(f.submissions[1]!.claim.recovery!.logicalWorkId).not.toBe(f.submissions[0]!.claim.recovery!.logicalWorkId);
  expect(f.submissions[1]!.prompt).toContain("First continuity instruction.");
  expect(f.submissions[1]!.prompt).toContain("new conversation restored from the current request");
  expect(retry.filter(event => event.type === "text_delta" && event.text.includes("new ChatGPT conversation"))).toHaveLength(1);
});

for (const manual of [false, true]) test(`page lifecycle regression: Windows identity admits the first request manual=${manual}`, async () => {
  const f = fixture(manual);
  f.descriptor.launcherInstance.startIdentity = "win32:134045280001234567";
  writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor), { mode: 0o600 });
  f.controls.actualRecovery = !manual;
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(1);
  expect(f.submissions[0]!.claim.recovery!.launcherInstance).toEqual(f.descriptor.launcherInstance);
});

for (const manual of [false, true]) for (const unavailable of ["descriptor", "helper"] as const) test(`page lifecycle regression: completed replay checks the live page before using cached output (${unavailable}, manual=${manual})`, async () => {
  const f = fixture(manual);
  const original = await f.run(f.request());
  const bindings = continuityBindingsFor(f.statePath);
  const thread = continuityDigest(f.threadId);
  const binding = bindings.observed(thread)!;
  const before = bindings.recoveryStore.get(thread)!;
  const registration = f.registrations.get(thread);
  const lastUsedAt = binding.lastUsedAt;
  const compatibleCalls = f.compatible.mock.calls.length;
  if (unavailable === "descriptor") rmSync(f.descriptorPath);
  f.compatible.mockRejectedValue(new Error("Helper unavailable"));
  if (unavailable === "descriptor") {
    await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
    expect(f.submissions).toHaveLength(1);
    expect(bindings.recoveryStore.get(thread)).toBeUndefined();
    expect(f.registrations.get(thread)).toBeUndefined();
    return;
  }
  const replay = await f.run(f.request());
  expect(replay.filter(event => event.type === "text_delta")).toEqual(original.filter(event => event.type === "text_delta"));
  expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.compatible.mock.calls.length).toBe(compatibleCalls);
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(1);
  expect(bindings.recoveryStore.get(thread)).toEqual(before);
  expect(f.registrations.get(thread)).toEqual(registration);
  expect(binding.lastUsedAt).toBe(lastUsedAt);
  await expect(f.run(f.request("Edited current instruction."))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(bindings.recoveryStore.get(thread)).toEqual(before);
});

for (const manual of [false, true]) for (const unavailable of ["descriptor", "helper"] as const) test(`page lifecycle regression: completed compaction replay checks the live page (${unavailable}, manual=${manual})`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = manual;
  f.controls.singleSourceTool = true;
  const source = f.request();
  const events = await f.run(source);
  const call = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
  const compact = call ? f.request("", "turn-first", [
    ...(source._rawBody as { input: unknown[] }).input,
    currentRecordedCall(f.provider, source),
    { type: "function_call_output", call_id: call.id, output: "Actual completed tool result." },
  ]) : structuredClone(source);
  compact._compactionRequest = true;
  const original = await f.run(compact);
  expect(original.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const bindings = continuityBindingsFor(f.statePath);
  const thread = continuityDigest(f.threadId);
  const binding = bindings.observed(thread)!;
  const before = bindings.recoveryStore.get(thread)!;
  const lastUsedAt = binding.lastUsedAt;
  const registration = f.registrations.get(thread);
  const submissions = f.submissions.length;
  const compatibleCalls = f.compatible.mock.calls.length;
  if (unavailable === "descriptor") rmSync(f.descriptorPath);
  f.compatible.mockRejectedValue(new Error("Helper unavailable"));
  if (unavailable === "descriptor") {
    await expect(f.run(structuredClone(compact))).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
    expect(f.submissions).toHaveLength(submissions);
    expect(bindings.recoveryStore.get(thread)).toBeUndefined();
    expect(f.registrations.get(thread)).toBeUndefined();
    return;
  }
  const replay = await f.run(structuredClone(compact));
  expect(replay.filter(event => event.type === "text_delta")).toEqual(original.filter(event => event.type === "text_delta"));
  expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.compatible.mock.calls.length).toBe(compatibleCalls);
  expect(f.submissions).toHaveLength(submissions);
  expect(f.pages.size).toBe(1);
  expect(binding.lastUsedAt).toBe(lastUsedAt);
  expect(bindings.recoveryStore.get(thread)).toEqual(before);
  expect(f.registrations.get(thread)).toEqual(registration);
});

for (const history of ["omitted", "edited"] as const) test(`page lifecycle regression: ordinary checkpoint recovery accepts ${history} covered results across attempts`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  const sourceEvents = await f.run(first);
  const call = sourceEvents.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const accepted = { type: "function_call_output", call_id: call.id, output: "Actual covered result." };
  const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    currentRecordedCall(f.provider, first), accepted]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  const bindings = continuityBindingsFor(f.statePath);
  const thread = continuityDigest(f.threadId);
  const before = bindings.recoveryStore.get(thread)!;
  const checkpoint = Object.values(before.checkpoints)[0]!;
  expect(checkpoint.coveredCallIds).toEqual([call.id]);
  f.pages.clear(); bindings.lose(bindings.observed(thread)!);
  f.controls.invokeSourceTools = false;
  f.controls.failAfterSendOnce = true;
  const request = () => f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    ...(history === "edited" ? [{ ...accepted, output: "Edited trusted historical result." }] : []),
  ]);
  expect((await f.run(request())).at(-1)).toMatchObject({ type: "error", code: "chatgpt_submitted_turn_failed" });
  expect(bindings.recoveryStore.get(thread)).toBeUndefined();
  expect((await f.run(request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = bindings.recoveryStore.get(thread)!;
  expect(after.calls[call.id]).toBeUndefined();
  expect(after.checkpoints[checkpoint.commitId]).toBeUndefined();
  expect(after.epoch).not.toBe(before.epoch);
  expect(JSON.stringify(taskEnvelope(f.submissions.at(-1)!.prompt))).toContain(JSON.stringify(summary.text).slice(1, -1));
  if (history === "edited") expect(f.submissions.at(-1)!.prompt).toContain("Edited trusted historical result.");
  expect(f.submissions).toHaveLength(4);
});

for (const history of ["omitted", "edited"] as const) test(`page lifecycle regression: closed appended checkpoint work accepts current ${history} result history`, async () => {
  const f = fixture(false, { taskUpdates: true });
  f.controls.nativeSourceTools = true;
  f.controls.invokeSourceTools = true;
  const first = f.request();
  const issued = await f.run(first);
  const call = issued.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const covered = { type: "function_call_output", call_id: call.id, output: "Actual covered result." };
  const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    currentRecordedCall(f.provider, first), covered]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  f.controls.singleSourceTool = true;
  const consumer = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input, marker]);
  const consumerEvents = await f.run(consumer);
  const consumerCall = consumerEvents.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const uncovered = { type: "function_call_output", call_id: consumerCall.id, output: "Actual result before append." };
  const task = { type: "message", role: "user", id: "append-checkpoint-B", content: "Accepted appended task B.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const old = history === "edited" ? [{ ...covered, output: "Edited trusted historical result." }] : [];
  const appended = f.request("", "turn-first", [marker, task, uncovered, ...old]);
  const bindings = continuityBindingsFor(f.statePath);
  const ref = bindings.observed(continuityDigest(f.threadId))!.recovery!;
  const record = bindings.recoveryStore.get(ref.thread)!;
  const logicalWorkId = recoveryDigest([record.scope, "turn-first", task.id, "ordinary"]);
  // Inject loss after the production append admission commits, before its local route publishes.
  recordRecoveryAppend(ref, { logicalWorkId, instructionIdentity: task.id, nativeTurnId: "turn-first",
    workPayloadDigest: chatGptContinuityInstructionPayloadDigest(appended), snapshotDigest: recoveryDigest(appended.context),
    localSessionId: "accepted-append-session", localTaskRevision: 1,
    results: [{ callId: uncovered.call_id, resultType: uncovered.type, resultDigest: recoveryResultDigest(uncovered) }] },
    [{ revision: 1, sourceMessageId: task.id, content: task.content, payloadDigest: recoveryDigest(task.content) }], 1);
  f.pages.clear(); bindings.lose(bindings.observed(ref.thread)!);
  f.controls.invokeSourceTools = false;
  evictOptionalRecoveryResults(f.statePath);
  const before = bindings.recoveryStore.get(ref.thread)!;
  expect(before.works[logicalWorkId]!.taskUpdateJournal).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 0 });
  const current = f.request("", "turn-first", [marker, task,
    ...(history === "edited" ? [{ ...uncovered, output: "Edited current-request result." }] : []), ...old]);
  const recovered = await f.run(current);
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(recovered.some(event => event.type === "tool_call_start")).toBe(false);
  const restoredTask = taskEnvelope(f.submissions.at(-1)!.prompt) as { messages: Array<{ role: string; content: unknown }> };
  expect(restoredTask.messages).toContainEqual({ role: "user", content: task.content });
  expect(JSON.stringify(restoredTask)).toContain(JSON.stringify(summary.text).slice(1, -1));
  if (history === "edited") expect(f.submissions.at(-1)!.prompt).toContain("Edited current-request result.");
  const after = bindings.recoveryStore.get(ref.thread)!;
  expect(after.currentWorkId).not.toBe(logicalWorkId);
  expect(after.works[logicalWorkId]).toBeUndefined();
  const freshJournal = after.works[after.currentWorkId!]!.taskUpdateJournal!;
  expect(freshJournal).toMatchObject({ acceptedRevision: 0, acknowledgedRevision: 0, updates: [], deliveries: [] });
  expect(freshJournal.streamId).not.toBe(before.works[logicalWorkId]!.taskUpdateJournal!.streamId);
  expect(after.calls[call.id]).toBeUndefined();
  expect(after.calls[uncovered.call_id]).toBeUndefined();
});

for (const manual of [false, true]) for (const pageState of ["healthy", "lost"] as const) test(`page lifecycle regression: ${manual ? "manual" : "automatic"} completed checkpoint consumer replays after later work with a ${pageState} page`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  const first = f.request();
  const issued = await f.run(first);
  const call = issued.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    currentRecordedCall(f.provider, first),
    { type: "function_call_output", call_id: call.id, output: "Actual covered result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const consumer = f.request("", "turn-first", [marker]);
  const completed = await f.run(consumer);
  expect(completed.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const originalText = completed.filter(event => event.type === "text_delta");
  expect((await f.run(f.request("", "turn-first", [marker]))).filter(event => event.type === "text_delta")).toEqual(originalText);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(consumer)}`)!;
  const answer = source.settledOutcome();
  if (answer?.type !== "final") throw new Error("Missing consumer answer");
  const bindings = continuityBindingsFor(f.statePath);
  const thread = continuityDigest(f.threadId);
  const consumerId = bindings.recoveryStore.get(thread)!.currentWorkId!;
  expect((await f.run(f.next(consumer, "turn-later", answer.answer))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const binding = bindings.observed(thread)!;
  expect(binding.recovery!.logicalWorkId).not.toBe(consumerId);
  if (pageState === "lost") { f.pages.clear(); bindings.lose(binding); }
  const before = bindings.recoveryStore.get(thread)!;
  const pageBefore = structuredClone(binding);
  const sends = f.submissions.length;
  const replay = await f.run(f.request("", "turn-first", [marker]));
  expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
  if (pageState === "healthy") {
    expect(replay.filter(event => event.type === "text_delta")).toEqual(originalText);
    expect(f.submissions).toHaveLength(sends);
    expect(bindings.recoveryStore.get(thread)).toEqual(before);
    expect(bindings.observed(thread)).toBe(binding);
    expect(binding).toEqual(pageBefore);
  } else {
    expect(f.submissions).toHaveLength(sends + 1);
    const after = bindings.recoveryStore.get(thread)!;
    expect(after.works[consumerId]).toBeUndefined();
    expect(after.epoch).not.toBe(before.epoch);
    expect(JSON.stringify(taskEnvelope(f.submissions.at(-1)!.prompt))).toContain(JSON.stringify(summary.text).slice(1, -1));
  }
});

test("page lifecycle regression: completed checkpoint consumer permits a new instruction after page loss", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  const events = await f.run(first);
  const call = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const accepted = { type: "function_call_output", call_id: call.id, output: "Actual covered result." };
  const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    currentRecordedCall(f.provider, first), accepted]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const consumer = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
  ]);
  expect((await f.run(consumer)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const bindings = continuityBindingsFor(f.statePath);
  const thread = continuityDigest(f.threadId);
  const before = bindings.recoveryStore.get(thread)!;
  f.pages.clear(); bindings.lose(bindings.observed(thread)!);
  expect((await f.run(f.next(consumer, "turn-new-after-completed-consumer", "Completed response 3."))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = bindings.recoveryStore.get(thread)!;
  expect(after.works[after.currentWorkId!]!.workLineageId).not.toBe(before.works[before.currentWorkId!]!.workLineageId);
  expect(after.calls[call.id]).toBeUndefined();
  expect(f.submissions).toHaveLength(4);
});

for (const manual of [false, true]) test(`page lifecycle regression: ${manual ? "manual" : "automatic"} completed work runs in a new generation after page loss`, async () => {
  const f = fixture(manual);
  const original = f.request();
  await f.run(original);
  f.pages.clear();
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect((await f.run(f.next(original))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[1]!.reused).toBe(false);
  expect(f.submissions[1]!.claim.recovery!.epoch).not.toBe(f.submissions[0]!.claim.recovery!.epoch);
});

for (const { failure, retainedPage, taskUpdates, pageState, interleavedRequest } of [
  { failure: "page-loss", retainedPage: false, taskUpdates: false, pageState: "ready", interleavedRequest: false },
  { failure: "delivery-timeout", retainedPage: false, taskUpdates: false, pageState: "ready", interleavedRequest: false },
  ...[false, true].flatMap(taskUpdates => (["ready", "running"] as const).flatMap(pageState =>
    [false, true].map(interleavedRequest =>
      ({ failure: "delivery-timeout", retainedPage: true, taskUpdates, pageState, interleavedRequest })))),
] as const)
test(`page lifecycle regression: a real harmless command runs once and its accepted result enters the replacement prompt (${failure}, retained=${retainedPage}, updates=${taskUpdates}, page=${pageState}, interleaved=${interleavedRequest})`, async () => {
  const f = fixture(false, { taskUpdates });
  f.controls.actualRecovery = retainedPage;
  f.controls.nativeSourceTools = taskUpdates;
  f.controls.failAfterToolsKeepPage = retainedPage;
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true; f.controls.failAfterToolsOnce = true;
  if (failure === "delivery-timeout") f.controls.afterToolsFailure = new ChatGptWebAdapterError(
    "Message delivery timed out. Please try again.",
    { status: 503, errorType: "server_error", code: "chatgpt_delivery_timeout", retryable: true },
  );
  const counter = join(f.statePath, "safe-execution-count");
  f.controls.command = harmlessContinuityCommand(counter, "real recovery result");
  const original = f.request();
  const events = await f.run(original);
  const call = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  expect(call).toBeDefined();
  const argumentsText = events.filter((event): event is Extract<AdapterEvent, { type: "tool_call_delta" }> => event.type === "tool_call_delta")
    .map(event => event.arguments).join("");
  expect(JSON.parse(argumentsText).cmd).toBe(f.controls.command);
  const processResult = await $`${{ raw: JSON.parse(argumentsText).cmd }}`.quiet().nothrow();
  const stdout = processResult.stdout.toString();
  expect(processResult.exitCode, processResult.stderr.toString()).toBe(0);
  const raw = (original._rawBody as { input: unknown[] }).input;
  const result = { type: "function_call_output", call_id: call.id, output: stdout };
  const resultInput = [...raw, currentRecordedCall(f.provider, original), result];
  const interrupted = await f.run(f.request("", "turn-first", resultInput));
  expect(interrupted.at(-1)).toMatchObject({ type: "error",
    code: retainedPage ? "chatgpt_delivery_timeout" : "chatgpt_submitted_turn_failed" });
  f.controls.invokeSourceTools = false;
  expect(f.submissions).toHaveLength(1);
  const before = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
  const oldTab = f.recoveryHost.turnTabs.values().next().value;
  if (retainedPage) {
    expect(before.works[before.currentWorkId!]!.attempts.at(-1)!.sendEvidence?.status).toBe("accepted");
    expect(before.calls[call.id]!.state).toBe("settled");
    for (const page of f.pages.values()) page.state = pageState;
    oldTab.status = pageState;
  }
  if (interleavedRequest) {
    await expect(f.run(f.next(original))).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(f.submissions).toHaveLength(1);
  }
  const recovered = await f.run(f.request("", "turn-first", resultInput));
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(readFileSync(counter, "utf8")).toBe("x");
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.prompt).toContain(stdout);
  expect(recovered.some(event => event.type === "tool_call_start")).toBe(false);
  if (retainedPage) {
    const after = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
    const attempts = after.works[before.currentWorkId!]!.attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.writerRetired).toBe(true);
    expect(oldTab.destroyed).toBe(true);
    expect(f.controls.actualAcquisitions).toBe(2);
  }
});

for (const taskUpdates of [false, true]) test(`task delivery timeout waits for a late real result before retiring its writer (updates=${taskUpdates})`, async () => {
  const f = fixture(false, { taskUpdates });
  f.controls.actualRecovery = true;
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.nativeSourceTools = taskUpdates;
  f.controls.failAfterToolsKeepPage = true;
  f.controls.beforeToolsResultFailure = new ChatGptWebAdapterError("Message delivery timed out. Please try again.",
    { status: 503, errorType: "server_error", code: "chatgpt_delivery_timeout", retryable: true });
  const counter = join(f.statePath, "late-execution-count");
  f.controls.command = harmlessContinuityCommand(counter, "late recovery result");
  const original = f.request();
  const events = await f.run(original);
  const call = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  expect(call).toBeDefined();
  const session = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(original)}`)!;
  expect(await session.browserOutcome).toMatchObject({ type: "error", error: { code: "chatgpt_delivery_timeout" } });
  const input = [...(original._rawBody as { input: unknown[] }).input, currentRecordedCall(f.provider, original)];
  await expect(f.run(f.request("", "turn-first", input))).rejects.toMatchObject({ code: "continuity_execution_unsettled" });
  const before = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
  expect(before.calls[call.id]!.state).toBe("delivery-possible");
  expect(before.works[before.currentWorkId!]!.attempts).toHaveLength(1);
  expect(before.works[before.currentWorkId!]!.attempts[0]!.writerRetired).toBe(false);
  expect(f.submissions).toHaveLength(1);
  expect(f.controls.actualAcquisitions).toBe(1);
  const processResult = await $`${{ raw: f.controls.command }}`.quiet().nothrow();
  expect(processResult.exitCode, processResult.stderr.toString()).toBe(0);
  const stdout = processResult.stdout.toString();
  f.controls.invokeSourceTools = false;
  const recovered = await f.run(f.request("", "turn-first", [...input,
    { type: "function_call_output", call_id: call.id, output: stdout }]));
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(recovered.some(event => event.type === "tool_call_start")).toBe(false);
  expect(readFileSync(counter, "utf8")).toBe("x");
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.prompt).toContain(stdout);
  expect(f.controls.actualAcquisitions).toBe(2);
  const after = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
  expect(after.works[before.currentWorkId!]!.attempts[0]!.writerRetired).toBe(true);
});

test("task delivery timeout cannot turn an unconfirmed Send into a new attempt", async () => {
  const f = fixture();
  f.controls.actualRecovery = true;
  const run = f.automatic.getMockImplementation()!;
  f.automatic.mockImplementation(turn => run({ ...turn, onSubmitted: async () => {
    throw new ChatGptWebAdapterError("Message delivery timed out. Please try again.",
      { status: 503, errorType: "server_error", code: "chatgpt_delivery_timeout", retryable: true });
  } }));
  const original = f.request();
  expect((await f.run(original)).at(-1)).toMatchObject({ type: "error", code: "chatgpt_delivery_timeout" });
  for (const page of f.pages.values()) page.state = "ready";
  for (const tab of f.recoveryHost.turnTabs.values()) tab.status = "ready";
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "error", code: "chatgpt_delivery_timeout" });
  const record = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
  const attempts = record.works[record.currentWorkId!]!.attempts;
  expect(attempts).toHaveLength(1);
  expect(attempts[0]!.sendEvidence?.status).toBe("possible");
  expect(attempts[0]!.writerRetired).toBe(false);
  expect(f.submissions).toHaveLength(1);
  expect(f.controls.actualAcquisitions).toBe(1);
});

for (const actualRecovery of [false, true]) for (const stage of ["prepared", "page-failed", "send-possible"] as const) test(`page lifecycle regression: a real exited backend ${actualRecovery && stage === "prepared" ? "pre-RPC page-possible" : stage} attempt permits current-request recovery actualLauncher=${actualRecovery}`, async () => {
  const f = fixture();
  f.controls.actualRecovery = actualRecovery;
  const original = f.request();
  bindContinuityRequestScope(original, chatGptWebExecutionNamespace(f.provider));
  const thread = continuityDigest(f.threadId);
  const logicalWorkId = recoveryDigest([original._continuityScope, "turn-first", continuityInstructionIdentity(original), "ordinary"]);
  const seed = { thread, scope: original._continuityScope!, logicalWorkId,
    instructionIdentity: continuityInstructionIdentity(original), nativeTurnId: "turn-first",
    workPayloadDigest: chatGptContinuityInstructionPayloadDigest(original), snapshotDigest: recoveryDigest(original.context),
    createPage: true, dispatchProtocolComplete: true };
  const oldLauncher = actualRecovery && stage === "send-possible" ? Bun.spawn([process.execPath, "-e",
    `import {continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))}; console.log(JSON.stringify(continuityProcessInstance())); setInterval(()=>{},1000);`],
    { stdout: "pipe", stderr: "pipe" }) : undefined;
  let oldLauncherIdentity: { pid: number; startIdentity: string; instanceId: string } | undefined;
  if (oldLauncher) {
    cleanups.push(async () => { oldLauncher.kill(); await oldLauncher.exited; });
    const reader = oldLauncher.stdout.getReader();
    const first = await reader.read(); reader.releaseLock();
    const value = JSON.parse(new TextDecoder().decode(first.value));
    oldLauncherIdentity = { pid: value.pid, startIdentity: value.startIdentity, instanceId: "b".repeat(64) };
  }
  const script = join(f.statePath, "crashed-backend.ts");
  writeFileSync(script, `import {ContinuityRecoveryStore,continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
import {ContinuityRegistrationStore} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-registration.ts"))};
const store = new ContinuityRecoveryStore(${JSON.stringify(f.statePath)});
const owner = continuityProcessInstance();
const input = ${JSON.stringify(seed)};
store.admitWork({...input, owner});
new ContinuityRegistrationStore(${JSON.stringify(f.statePath)}).claim(input.thread,input.scope,owner.id);
${stage !== "prepared" ? `store.markAttempt(input.thread,{scope:input.scope},{logicalWorkId:input.logicalWorkId,attempt:0,stage:"page-possible",launcherInstance:${oldLauncherIdentity ? JSON.stringify(oldLauncherIdentity) : actualRecovery ? JSON.stringify(f.descriptor.launcherInstance) : '{pid:owner.pid,startIdentity:owner.startIdentity,instanceId:"b".repeat(64)}'}});
${stage === "page-failed" ? 'store.recordFailure(input.thread,{scope:input.scope},input.logicalWorkId);' : 'store.markAttempt(input.thread,{scope:input.scope},{logicalWorkId:input.logicalWorkId,attempt:0,stage:"send-possible"});'}` : ""}
`);
  if (actualRecovery && stage === "prepared") {
    // Run the public adapter through its durable acquisition boundary. The backend
    // exits before the worker can make its first Launcher acquisition RPC.
    writeFileSync(script, `import {createChatGptWebAdapter} from ${JSON.stringify(resolve("tests/helpers/chatgpt-web-adapter.ts"))};
import {ChatGptBrowserWorker} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/browser-worker.ts"))};
import {parseRequest} from ${JSON.stringify(resolve("src/responses/parser.ts"))};
import {ContinuityRecoveryStore} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
const provider=${JSON.stringify(f.provider)};
const parsed=parseRequest(${JSON.stringify(original._rawBody)}); parsed._conversationPolicy="task";
const worker=ChatGptBrowserWorker.forProvider(provider);
worker.assertContinuityCompatible=async()=>{}; worker.supportsTaskUpdates=async()=>false;
worker.run=async turn=>{
  const record=new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}).get(${JSON.stringify(thread)});
  const attempt=record.works[record.currentWorkId].attempts.at(-1);
  if(attempt.stage!=="page-possible" || attempt.acquisitionEvidence?.status!=="possible" || attempt.sendEvidence || !turn.recoveryRequestId) process.exit(2);
  process.exit(0);
};
const adapter=createChatGptWebAdapter(provider); const context={headers:new Headers()};
await adapter.preflight(parsed,context); await adapter.runTurn(parsed,context,()=>{}); process.exit(3);
`);
  }
  const processResult = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  expect(await processResult.exited, await new Response(processResult.stderr).text()).toBe(0);
  const before = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  if (actualRecovery && stage === "prepared") {
    const attempt = before.works[before.currentWorkId!]!.attempts[0]!;
    expect(["exited", "unverified"]).toContain(continuityProcessInstanceStatus(before.owner));
    expect(attempt.stage).toBe("page-possible");
    expect(attempt.sendEvidence).toBeUndefined();
    expect(attempt.acquisitionEvidence?.status).toBe("possible");
    expect(f.controls.actualAcquisitions).toBe(0);
    expect(f.recoveryHost.turnTabs.size).toBe(0);
    const identity = recoveryIdentity(before, new ContinuityRecoveryStore(f.statePath).installationId());
    launcherAuthority.bindExecutionAuthority(f.recoveryHost, identity, f.statePath);
    expect(launcherRecovery.queryContinuityTransaction(f.recoveryHost, identity)).toMatchObject({
      state: "missing", hostNoWriter: true, writerRetired: false, executionIsolated: false,
    });
  }
  f.controls.queryPhase = stage === "prepared" ? "missing" : "send-possible";
  const changedHistory = f.request("", "turn-first", [
    { type: "message", role: "assistant", content: "Edited completed history H2." },
    ...(original._rawBody as { input: unknown[] }).input,
  ]);
  if (actualRecovery && stage === "prepared" && before.owner.startIdentity === "unverified") {
    // Abrupt exit held the actual admission lock. This platform cannot prove the
    // recorded process identity exited; report the infrastructure fault, not old task eligibility.
    await expect(f.run(changedHistory)).rejects.toMatchObject({ code: "continuity_configuration_conflict", message: expect.stringContaining("storage is busy") });
    expect(f.submissions).toHaveLength(0);
    return;
  }
  expect((await f.run(changedHistory)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
  if (actualRecovery) expect(f.controls.actualAcquisitions).toBe(1);
  expect(f.submissions[0]!.prompt).toContain("Edited completed history H2.");
  const after = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  expect(after.works[before.currentWorkId!]).toBeUndefined();
  expect(after.works[after.currentWorkId!]!.attempts).toHaveLength(1);
  expect(after.transaction!.transactionId).not.toBe(before.transaction!.transactionId);
  expect(after.epoch).not.toBe(before.epoch);
  if (oldLauncher) expect(oldLauncher.exitCode).toBeNull();
});

test("page lifecycle regression: real typed unacquired rollback permits a new generation after backend exit", async () => {
  const f = fixture();
  f.controls.actualRecovery = true;
  const { BrowserHost } = require("../launcher/electron/browser-host.cjs");
  const { BrowserControlServer } = require("../launcher/electron/control-server.cjs");
  const host = Object.assign(Object.setPrototypeOf(f.recoveryHost, BrowserHost.prototype), {
    manualCompletionSignals: new Map(), manualTerminalSignals: new Map(), userCancelledTurnOwners: new Map(),
    browserInteractionMode: () => "automatic", logger: { info() {}, warn() {}, error() {} },
  });
  for (let ordinal = 1; ordinal <= 5; ordinal++) host.turnTabs.set(`busy-${ordinal}`, {
    id: `busy-${ordinal}`, traceId: `busy-${ordinal}`, ordinal, status: "running",
    view: { webContents: { isDestroyed: () => false, close() { throw new Error("Active pages must remain"); } } },
  });
  const server = await new BrowserControlServer({ logger: host.logger, getPreferences: () => ({}), getBrowserHost: () => host }).start();
  cleanups.push(async () => { await server.close(); });
  const realDescriptorPath = join(f.statePath, "real-capacity-control.json");
  writeFileSync(realDescriptorPath, JSON.stringify({ ...f.descriptor, control: server.descriptor() }), { mode: 0o600 });
  const original = f.request();
  const thread = continuityDigest(f.threadId);
  const script = join(f.statePath, "known-unsent-backend.ts");
  // Capacity inspection and actual acquisition are independent: the public
  // adapter sees room at preflight, then the real host rejects a full page set.
  writeFileSync(script, `import {createChatGptWebAdapter} from ${JSON.stringify(resolve("tests/helpers/chatgpt-web-adapter.ts"))};
import {ChatGptBrowserWorker} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/browser-worker.ts"))};
import {parseRequest} from ${JSON.stringify(resolve("src/responses/parser.ts"))};
import {notifyLauncherTurn,LauncherKnownUnsentReceiptError} from ${JSON.stringify(resolve("src/launcher-browser-host.ts"))};
import {ContinuityRecoveryStore} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
const provider=${JSON.stringify(f.provider)};
const parsed=parseRequest(${JSON.stringify(original._rawBody)}); parsed._conversationPolicy="task";
const worker=ChatGptBrowserWorker.forProvider(provider); let typed=false;
worker.assertContinuityCompatible=async()=>{}; worker.supportsTaskUpdates=async()=>false;
worker.run=async turn=>{try {
  await notifyLauncherTurn(${JSON.stringify(realDescriptorPath)}, {phase:"start",traceId:turn.traceId,helperPid:process.pid,
    conversationKey:turn.conversationKey,continuity:turn.continuity,recovery:turn.continuity.recovery,
    recoveryStoreDirectory:turn.recoveryStoreDirectory,requestId:turn.recoveryRequestId});
  throw new Error("Expected physical capacity refusal");
} catch(error) {typed=error instanceof LauncherKnownUnsentReceiptError; throw error;}};
const adapter=createChatGptWebAdapter(provider),context={headers:new Headers()};
await adapter.preflight(parsed,context); await adapter.runTurn(parsed,context,()=>{});
const record=new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}).get(${JSON.stringify(thread)});
const attempt=record.works[record.currentWorkId].attempts.at(-1);
if(!typed || attempt.stage!=="prepared" || attempt.acquisitionEvidence?.status!=="not-acquired" || !attempt.acquisitionEvidence.receiptId || attempt.sendEvidence) process.exit(2);
process.exit(0);
`);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  const store = new ContinuityRecoveryStore(f.statePath), before = store.get(thread)!;
  expect(["exited", "unverified"]).toContain(continuityProcessInstanceStatus(before.owner));
  const old = before.works[before.currentWorkId!]!.attempts[0]!;
  expect(old).toMatchObject({ stage: "prepared", writerRetired: false, acquisitionEvidence: { status: "not-acquired" } });
  expect(old.sendEvidence).toBeUndefined();
  const records = [...host.continuityTransactions.values()] as Array<{ state: string; writerRetired: boolean }>;
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ state: "missing", writerRetired: true });
  expect(host.turnTabs.size).toBe(5);
  expect(f.submissions).toHaveLength(0);
  host.turnTabs.clear();
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = store.get(thread)!, work = after.works[after.currentWorkId!]!;
  expect(work.logicalWorkId).not.toBe(before.currentWorkId!);
  expect(after.works[before.currentWorkId!]).toBeUndefined();
  expect(work.attempts).toHaveLength(1);
  expect(work.attempts[0]!.epoch).not.toBe(before.epoch);
  expect(f.controls.actualAcquisitions).toBe(1);
  expect(f.submissions).toHaveLength(1);
});

for (const withResult of [false, true]) for (const stage of ["prepared", "send-possible"] as const) test(`page lifecycle regression: checkpoint-only consumer follows page lifetime after ${stage} failure result=${withResult}`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const original = f.request();
  await f.run(original);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(original)}`)!;
  const compact = f.request("", "turn-first", [
    ...(original._rawBody as { input: unknown[] }).input,
    recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Actual source result before consumer." },
  ]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  if (stage === "prepared") f.controls.preLeaseFailures = 1;
  else f.controls.failAfterSendOnce = true;
  const request = () => f.request("", "turn-first", [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    ...(withResult ? [(compact._rawBody as { input: unknown[] }).input.at(-1)] : [])]);
  const failed = await f.run(request());
  expect(failed.at(-1)).toMatchObject({ type: "error" });
  const store = new ContinuityRecoveryStore(f.statePath);
  const thread = continuityDigest(f.threadId);
  const before = store.get(thread);
  const checkpoint = before ? Object.values(before.checkpoints)[0] : undefined;
  const consumerId = checkpoint?.continuation.consumerLogicalWorkId ?? f.submissions.at(-1)!.claim.recovery!.logicalWorkId;
  expect(consumerId).toBeDefined();
  if (stage === "send-possible") expect(before).toBeUndefined();
  const completed = await f.run(request());
  expect(completed.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = store.get(thread)!;
  if (stage === "prepared") {
    expect(after.checkpoints[checkpoint!.commitId]!.continuation.consumerLogicalWorkId).toBe(consumerId);
    expect(Object.keys(after.works).sort()).toEqual(Object.keys(before!.works).sort());
    expect(after.works[consumerId]!.state).toBe("completed");
  } else {
    expect(after.works[consumerId]).toBeUndefined();
    expect(after.checkpoints).toEqual({});
    expect(after.works[after.currentWorkId!]!.state).toBe("completed");
  }
  expect(f.submissions.at(-1)!.prompt).toContain("Verified checkpoint.");
  expect(completed.filter(event => event.type === "tool_call_start")).toHaveLength(0);
});

for (const manual of [false, true]) test(`page lifecycle regression: ${manual ? "manual" : "automatic"} unknown inspection recovers current input in a new page`, async () => {
  const f = fixture(manual);
  const original = f.request();
  await f.run(original);
  const before = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
  f.controls.inspectFailures = 1;
  expect((await f.run(f.next(original))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.pages.size).toBe(1);
  const recovered = new ContinuityRecoveryStore(f.statePath).get(before.thread)!;
  expect(recovered.epoch).not.toBe(before.epoch);
  expect(recovered.works[before.currentWorkId!]).toBeUndefined();
  expect((await f.run(f.next(original))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).not.toBe(f.submissions[0]!.key);
  expect(f.submissions[1]!.reused).toBe(false);
  expect(f.submissions[1]!.prompt).toContain("First continuity instruction.");
});

test("page lifecycle regression: a lost page cannot promote historical discovery into new tool authority", async () => {
  const f = fixture();
  const original = f.request();
  await f.run(original);
  f.pages.clear();
  const next = f.next(original);
  const body = next._rawBody as { input: unknown[] };
  body.input.unshift({ type: "tool_search_output", call_id: "unowned-historical-search", status: "completed",
    tools: [{ type: "function", name: "unapproved_recovery_tool", description: "Unowned history", parameters: { type: "object" } }] });
  const replay = parseRequest({ ...next._rawBody as object });
  replay._conversationPolicy = "task";
  expect((await f.run(replay)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(replay.context.tools?.some(tool => tool.name === "unapproved_recovery_tool")).toBe(false);
  expect(f.submissions).toHaveLength(2);
});

for (const localBody of [false, true]) test(`page lifecycle regression: closed consumed continuation uses only request-carried results local=${localBody}`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const original = f.request();
  await f.run(original);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(original)}`)!;
  const compact = f.request("", "turn-first", [...(original._rawBody as { input: unknown[] }).input,
    recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint");
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  f.controls.singleSourceTool = true;
  f.controls.failAfterToolsOnce = localBody;
  const consumerRequest = f.request("", "turn-first", [marker]);
  await f.run(consumerRequest);
  const consumer = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(consumerRequest)}`)!;
  const consumerCall = recordedCall(consumer.outstanding()[0]!);
  const result = { type: "function_call_output", call_id: consumer.outstanding()[0]!.callId, output: "Actual uncovered consumer result." };
  if (localBody) expect((await f.run(f.request("", "turn-first", [marker, consumerCall, result]))).at(-1)).toMatchObject({ type: "error" });
  else {
    f.pages.clear();
    const bindings = continuityBindingsFor(f.statePath);
    bindings.lose(bindings.observed(continuityDigest(f.threadId))!);
  }
  const store = new ContinuityRecoveryStore(f.statePath);
  const thread = continuityDigest(f.threadId);
  const oldWork = consumer.runtime.continuityBinding!.recovery!.logicalWorkId;
  f.controls.invokeSourceTools = false;
  const recovered = await f.run(f.request("", "turn-first", [marker, consumerCall, ...localBody ? [] : [result]]));
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = store.get(thread)!;
  expect(after.currentWorkId).not.toBe(oldWork);
  expect(after.works[oldWork]).toBeUndefined();
  expect(after.calls[result.call_id]).toBeUndefined();
  if (localBody) expect(f.submissions.at(-1)!.prompt).not.toContain(result.output);
  else expect(f.submissions.at(-1)!.prompt).toContain(result.output);
  expect(JSON.stringify(taskEnvelope(f.submissions.at(-1)!.prompt))).toContain(JSON.stringify(summary.text).slice(1, -1));
});

test("page lifecycle regression: authenticated interrupt persists stop before receipt and later page loss permits recovery", async () => {
  const f = fixture(false, { threadId: "thread_real_interrupt" });
  f.controls.invokeSourceTools = true;
  await f.run(f.request());
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const provider = spyOn(configuration, "providerConfig").mockReturnValue(f.provider);
  cleanups.push(async () => { provider.mockRestore(); });
  const server = startServer(config, { accessPolicy: OPENAI_ACCESS });
  cleanups.push(async () => { await server.stop(true); });
  const response = await fetch(`http://127.0.0.1:${server.port}/admin/interrupt-turn`, {
    method: "POST", headers: { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json" },
    body: JSON.stringify({ threadId: f.threadId, turnId: "turn-first" }),
  });
  expect(response.status).toBe(200);
  const record = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
  expect(record.works[record.currentWorkId!]!.state).toBe("stopped");
  f.pages.clear();
  f.controls.invokeSourceTools = false;
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const restored = new ContinuityRecoveryStore(f.statePath).get(record.thread)!;
  expect(restored.epoch).not.toBe(record.epoch);
  expect(restored.works[record.currentWorkId!]).toBeUndefined();
});

test("page lifecycle regression: failed acquisition does not exhaust future requests' recovery rights", async () => {
  const f = fixture();
  f.controls.actualRecovery = true;
  f.controls.acquisitionFailures = 5;
  const epochs = new Set<number>();
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "error", code: "continuity_unverified" });
    const record = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
    epochs.add(record.epoch);
    expect(record.works[record.currentWorkId!]!.retryBudget?.attempts).toBe(1);
    expect(record.works[record.currentWorkId!]!.retryBudget?.lastFailureAt).toBeNumber();
  }
  expect(epochs.size).toBe(5);
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.actualAcquisitions).toBe(6);
  expect(f.submissions).toHaveLength(1);
});

test.skipIf(continuityProcessInstance().startIdentity === "unverified")("page lifecycle regression: old acquisition exhaustion cannot block recovery after an actual backend exit", async () => {
  const f = fixture();
  const original = f.request();
  bindContinuityRequestScope(original, chatGptWebExecutionNamespace(f.provider));
  const thread = continuityDigest(f.threadId);
  const work = recoveryDigest([original._continuityScope, "turn-first", continuityInstructionIdentity(original), "ordinary"]);
  const input = { thread, scope: original._continuityScope!, logicalWorkId: work,
    instructionIdentity: continuityInstructionIdentity(original), nativeTurnId: "turn-first",
    workPayloadDigest: chatGptContinuityInstructionPayloadDigest(original), snapshotDigest: recoveryDigest(original.context),
    createPage: true, dispatchProtocolComplete: true };
  const script = `import {ContinuityRecoveryStore,continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
import {recoveryIdentity} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-runtime.ts"))};
import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);
const api=require(${JSON.stringify(resolve("launcher/electron/continuity-recovery.cjs"))});
const authority=require(${JSON.stringify(resolve("launcher/electron/continuity-execution-authority.cjs"))});
const store=new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}), input=${JSON.stringify(input)}, owner=continuityProcessInstance();
if(owner.startIdentity==='unverified'){console.log('unverified');process.exit(0);}
const launcherInstance={pid:owner.pid,startIdentity:owner.startIdentity,instanceId:'b'.repeat(64)};
const host={turnTabs:new Map(),continuityLauncherInstance:launcherInstance}; let count=0;
let record=store.admitWork({...input,owner});
for(let attempt=0;attempt<4;attempt++){
 if(attempt) record=store.reserveRecovery(input.thread,{scope:input.scope},{logicalWorkId:input.logicalWorkId,owner,snapshotDigest:input.snapshotDigest});
 record=store.markAttempt(input.thread,{scope:input.scope},{logicalWorkId:input.logicalWorkId,attempt,stage:'page-possible',launcherInstance});
 const recovery=recoveryIdentity(record,store.installationId());
 authority.bindExecutionAuthority(host,recovery,${JSON.stringify(f.statePath)});
 try{await api.acquireContinuityTransaction(host,{owner:owner.id,recovery},'trace'+attempt,owner.pid,'page'+attempt,'automatic',()=>{count++;throw Error('injected acquisition failure');});}catch{}
 store.recordFailure(input.thread,{scope:input.scope},input.logicalWorkId);
 store.retireAttempt(input.thread,{scope:input.scope},input.logicalWorkId,attempt); await api.retireContinuityWriter(host,recovery);
} console.log(count);`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  const output = (await new Response(child.stdout).text()).trim();
  if (output === "unverified") { expect(f.submissions).toHaveLength(0); return; }
  expect(output).toBe("4");
  const before = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  expect(before.works[work]!.retryBudget?.attempts).toBe(4);
  expect((await f.run(original)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  expect(after.works[work]).toBeUndefined();
  expect(after.epoch).not.toBe(before.epoch);
  expect(f.submissions).toHaveLength(1);
});

for (const stop of ["mode-exit", "native"] as const) test(`page lifecycle regression: old ${stop} does not block recovery after backend restart`, async () => {
  const f = fixture(false, { threadId: `thread_restart_stop_${stop}` });
  const original = f.request();
  bindContinuityRequestScope(original, chatGptWebExecutionNamespace(f.provider));
  const thread = continuityDigest(f.threadId);
  const work = recoveryDigest([original._continuityScope, "turn-first", continuityInstructionIdentity(original), "ordinary"]);
  const input = { thread, scope: original._continuityScope!, logicalWorkId: work,
    instructionIdentity: continuityInstructionIdentity(original), nativeTurnId: "turn-first",
    workPayloadDigest: chatGptContinuityInstructionPayloadDigest(original), snapshotDigest: recoveryDigest(original.context),
    createPage: true, dispatchProtocolComplete: true };
  const child = Bun.spawn([process.execPath, "-e", `import {ContinuityRecoveryStore,continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
    new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}).admitWork({...${JSON.stringify(input)},owner:continuityProcessInstance()});`], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  expect(continuityBindingsFor(f.statePath).observed(thread)).toBeUndefined();
  if (stop === "mode-exit") await leaveContinuityMode(f.statePath, f.threadId);
  else {
    const provider = spyOn(configuration, "providerConfig").mockReturnValue(f.provider);
    const config = { ...defaultConfig("browser-only"), port: 0 };
    const server = startServer(config, { accessPolicy: OPENAI_ACCESS });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/admin/interrupt-turn`, {
        method: "POST", headers: { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json" },
        body: JSON.stringify({ threadId: f.threadId, turnId: "turn-first" }),
      });
      expect(response.status).toBe(200);
    } finally { await server.stop(true); provider.mockRestore(); }
  }
  const store = new ContinuityRecoveryStore(f.statePath);
  const stopped = store.get(thread)!;
  expect(stopped.works[work]!.state).toBe("stopped");
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(store.get(thread)!.works[work]).toBeUndefined();
  expect(store.get(thread)!.epoch).not.toBe(stopped.epoch);
  expect((await f.run(f.next(original))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
});

const crashBudgetRoot = process.env.CGW_RECOVERY_CRASH_BUDGET_ROOT;

test.skipIf(!crashBudgetRoot)("recovery v3 worker: exit before acquisition failure receipt", async () => {
  const f = fixture(false, { root: crashBudgetRoot! });
  f.controls.actualRecovery = true;
  f.controls.acquisitionFailures = 1;
  const save = (code?: string) => {
    const record = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
    writeFileSync(join(crashBudgetRoot!, "observed.json"), JSON.stringify({ calls: f.controls.actualAcquisitions,
      attempts: record.works[record.currentWorkId!]!.attempts.length,
      budget: record.works[record.currentWorkId!]!.retryBudget, epoch: record.epoch, code }));
  };
  spyOn(ContinuityRecoveryStore.prototype, "settleWriterFailure").mockImplementation(() => { save(); process.exit(0); });
  try { await f.run(f.request()); throw new Error("The acquisition should fail or exhaust its budget"); }
  catch (error) { save((error as { code?: string }).code); process.exit(0); }
});

test.skipIf(continuityProcessInstance().startIdentity === "unverified")("page lifecycle process: five no-page backend crashes each permit a fresh acquisition", async () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-budget-crash-"));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const observations: Array<{ calls: number; attempts: number; epoch: number;
    budget?: { attempts: number; startedAt: number; lastFailureAt?: number }; code?: string }> = [];
  for (let index = 0; index < 5; index++) {
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "^recovery v3 worker: exit before acquisition failure receipt$"],
      { env: { ...process.env, CGW_RECOVERY_CRASH_BUDGET_ROOT: root }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    observations.push(JSON.parse(readFileSync(join(root, "observed.json"), "utf8")));
  }
  expect(observations.map(value => value.calls)).toEqual([1, 1, 1, 1, 1]);
  expect(observations.map(value => value.attempts)).toEqual([1, 1, 1, 1, 1]);
  expect(observations.map(value => value.budget?.attempts)).toEqual([1, 1, 1, 1, 1]);
  expect(observations.every(value => value.budget?.lastFailureAt === undefined)).toBe(true);
  expect(new Set(observations.map(value => value.budget?.startedAt)).size).toBe(5);
  expect(new Set(observations.map(value => value.epoch)).size).toBe(5);
  expect(observations.some(value => value.code === "continuity_retry_exhausted")).toBe(false);
}, 30_000);

async function preparedMigrationFixture(creating = false, launcherInstance?: { pid: number; startIdentity: string; instanceId: string }) {
  const f = fixture();
  if (launcherInstance) {
    f.descriptor.pid = launcherInstance.pid;
    f.descriptor.launcherInstance = launcherInstance;
    f.recoveryHost.continuityLauncherInstance = launcherInstance;
    writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
  }
  f.controls.actualRecovery = true;
  const original = f.request();
  const namespace = chatGptWebExecutionNamespace(f.provider);
  bindContinuityRequestScope(original, namespace);
  const thread = continuityDigest(f.threadId), scope = original._continuityScope!;
  const logicalWorkId = recoveryDigest([scope, "turn-first", continuityInstructionIdentity(original), "ordinary", 0]);
  const seed = { thread, scope, logicalWorkId, instructionIdentity: continuityInstructionIdentity(original), nativeTurnId: "turn-first",
    workPayloadDigest: chatGptContinuityInstructionPayloadDigest(original), snapshotDigest: recoveryDigest(original.context), createPage: true, dispatchProtocolComplete: true };
  const child = Bun.spawn([process.execPath, "-e", `import {ContinuityRecoveryStore,continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
const store=new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}),input=${JSON.stringify(seed)};
store.admitWork({...input,owner:continuityProcessInstance()});
store.markAttempt(input.thread,{scope:input.scope},{logicalWorkId:input.logicalWorkId,attempt:0,stage:'page-possible',launcherInstance:${JSON.stringify(f.descriptor.launcherInstance)}});`], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  const store = new ContinuityRecoveryStore(f.statePath), before = store.get(thread)!;
  const { recoveryIdentity } = await import("../src/adapters/chatgpt-web/continuity-recovery-runtime");
  const { chatGptConversationKey } = await import("../src/adapters/chatgpt-web/conversation-key");
  const old = recoveryIdentity(before, store.installationId());
  launcherAuthority.bindExecutionAuthority(f.recoveryHost, old, f.statePath);
  const claim = { owner: before!.owner.id, recovery: old };
  original._continuityEpoch = before.epoch;
  const key = chatGptConversationKey(original, namespace)!;
  let finish!: () => void;
  const create = () => {
    const tab: any = { id: "prepared-tab", traceId: "prepared-trace", helperPid: child.pid, status: "running", destroyed: false,
      continuityLeaseId: "1".repeat(32), view: { webContents: { isDestroyed: () => tab.destroyed } } };
    launcherLease.bindContinuityTab(tab, claim);
    f.recoveryHost.turnTabs.set(tab.id, tab);
    return { continuity: launcherLease.continuityLease(tab) };
  };
  const acquired = launcherRecovery.acquireContinuityTransaction(f.recoveryHost, claim, "prepared-trace", child.pid, key, "automatic",
    () => creating ? new Promise(resolve => { finish = () => resolve(create()); }) : create());
  if (creating) void acquired.catch(() => {});
  return { f, store, before, old, original, acquired, finish: () => finish(), recoveryIdentity };
}

for (const fault of ["creating", "before-handler", "lost-receipt"] as const) {
  test.skipIf(continuityProcessInstance().startIdentity === "unverified")(`page lifecycle process: prepared migration handles ${fault}`, async () => {
    const { f, store, before, old, acquired, finish, recoveryIdentity } = await preparedMigrationFixture(fault === "creating");
    if (fault === "before-handler") f.controls.prepareBeforeFailures = 1;
    if (fault === "lost-receipt") f.controls.prepareAfterFailures = 1;
    const sameRequest = f.request();
    if (fault === "creating") {
      expect(f.recoveryHost.turnTabs.size).toBe(0);
      expect((await f.run(structuredClone(sameRequest))).at(-1)).toMatchObject({ type: "done", endTurn: true });
      const successor = store.get(before.thread)!;
      expect(successor.epoch).not.toBe(before.epoch);
      expect(successor.works[before.currentWorkId!]).toBeUndefined();
      finish(); await expect(acquired).rejects.toBeDefined();
      expect(store.get(before.thread)).toEqual(successor);
      expect(f.controls.actualAcquisitions).toBe(1);
      expect(f.submissions).toHaveLength(1);
      expect(f.recoveryHost.turnTabs.size).toBe(1);
      return;
    }
    await expect(f.run(structuredClone(sameRequest))).rejects.toMatchObject({ code: "continuity_unverified" });
    const pending = store.get(before.thread)!;
    expect(pending.owner).toEqual(before.owner);
    expect(pending.transaction).toEqual(before.transaction);
    expect(f.submissions).toHaveLength(0);
    expect(f.controls.actualAcquisitions).toBe(0);
    {
      expect(pending.pendingPreparation?.expected).toEqual({ owner: before!.owner, transaction: before.transaction! });
      const { assertRecoveryWriter } = await import("../src/adapters/chatgpt-web/continuity-recovery-runtime");
      expect(() => assertRecoveryWriter({ directory: f.statePath, thread: before.thread, logicalWorkId: before.currentWorkId!, attempt: 0 }))
        .toThrow("still being coordinated");
      const hostTag = fault === "lost-receipt" ? recoveryIdentity({ ...pending, ...pending.pendingPreparation!.target }, store.installationId()) : old;
      expect(launcherRecovery.queryContinuityTransaction(f.recoveryHost, hostTag).state).toBe("prepared");
      await expect(f.run(f.request("Changed body under the accepted instruction ID."))).rejects.toMatchObject({ code: "continuity_source_unproven" });
      expect(store.get(before.thread)).toEqual(pending);
    }
    expect((await f.run(structuredClone(sameRequest))).at(-1)).toMatchObject({ type: "done", endTurn: true });
    const after = store.get(before.thread)!;
    expect(after.pendingPreparation).toBeUndefined();
    expect(after.works[after.currentWorkId!]!.attempts).toHaveLength(1);
    expect(after.works[after.currentWorkId!]!.retryBudget).toBeUndefined();
    expect(after.transaction!.snapshotVersion).toBe(1);
    expect(f.submissions).toHaveLength(1);
    expect(f.controls.actualAcquisitions).toBe(0);
    expect(f.recoveryHost.turnTabs.size).toBe(1);
  });
}

for (const phase of ["before-rpc", "after-rpc", "after-complete", "second-backend-exit"] as const) {
  test.skipIf(continuityProcessInstance().startIdentity === "unverified")(`page lifecycle process: persisted migration survives ${phase}`, async () => {
    const { f, store, before } = await preparedMigrationFixture();
    const migrate = async (apply: boolean) => {
      const script = `import {ContinuityRecoveryStore,continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
import {recoveryIdentity} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-runtime.ts"))};
import {updateLauncherContinuityPreparation} from ${JSON.stringify(resolve("src/launcher-browser-host.ts"))};
const store=new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}),thread=${JSON.stringify(before.thread)};let record=store.get(thread)!;
if(record.pendingPreparation){const p=record.pendingPreparation;await updateLauncherContinuityPreparation(${JSON.stringify(f.descriptorPath)},{expected:recoveryIdentity({...record,...p.expected},store.installationId()),recovery:recoveryIdentity({...record,...p.target},store.installationId())});record=store.completePreparation(thread,{scope:record.scope,expectedVersion:record.version},p.preparationId);}
record=store.beginPreparation(thread,{scope:record.scope,expectedVersion:record.version},{logicalWorkId:record.currentWorkId!,owner:continuityProcessInstance(),snapshotDigest:'9'.repeat(64),launcherInstance:${JSON.stringify(f.descriptor.launcherInstance)}});
const p=record.pendingPreparation!;
${apply ? `await updateLauncherContinuityPreparation(${JSON.stringify(f.descriptorPath)},{expected:recoveryIdentity({...record,...p.expected},store.installationId()),recovery:recoveryIdentity({...record,...p.target},store.installationId())});` : ""}
${phase === "after-complete" ? 'store.completePreparation(thread,{scope:record.scope,expectedVersion:record.version},p.preparationId);' : ""}
process.exit(0);`;
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    };
    await migrate(phase !== "before-rpc");
    if (phase === "second-backend-exit") await migrate(false);
    if (phase === "after-complete") expect(store.get(before.thread)!.pendingPreparation).toBeUndefined();
    else expect(store.get(before.thread)!.pendingPreparation).toBeDefined();
    expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
    const after = store.get(before.thread)!;
    expect(after.pendingPreparation).toBeUndefined();
    expect(after.transaction!.snapshotVersion).toBe(phase === "second-backend-exit" ? 3 : 2);
    expect(after.works[after.currentWorkId!]!.attempts).toHaveLength(1);
    expect(after.works[after.currentWorkId!]!.retryBudget).toBeUndefined();
    expect(f.controls.actualAcquisitions).toBe(0);
    expect(f.submissions).toHaveLength(1);
  });
}

for (const applied of [false, true]) {
  test.skipIf(continuityProcessInstance().startIdentity === "unverified")(`page lifecycle process: closed stopped preparation accepts the current task applied=${applied}`, async () => {
    const { f, store, before } = await preparedMigrationFixture();
    if (applied) f.controls.prepareAfterFailures = 1;
    else f.controls.prepareBeforeFailures = 1;
    await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_unverified" });
    expect(store.get(before.thread)!.pendingPreparation).toBeDefined();
    await leaveContinuityMode(f.statePath, f.threadId);
    expect(store.get(before.thread)!.works[before.currentWorkId!]!.state).toBe("stopped");
    for (const tab of [...f.recoveryHost.turnTabs.values()]) f.recoveryHost.removeTurnTab(tab);
    f.pages.clear();
    expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
    const after = store.get(before.thread)!;
    expect(after.pendingPreparation).toBeUndefined();
    expect(after.retiredPreparation).toBeUndefined();
    expect(after.works[before.currentWorkId!]).toBeUndefined();
    expect(after.epoch).not.toBe(before.epoch);
    expect(f.controls.actualAcquisitions).toBe(1);
    expect(f.submissions).toHaveLength(1);
    expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(f.submissions).toHaveLength(1);
  });
}

test.skipIf(continuityProcessInstance().startIdentity === "unverified")("page lifecycle process: an exactly retired pending target admits a fresh page", async () => {
  const { f, store, before, recoveryIdentity } = await preparedMigrationFixture();
  f.controls.prepareAfterFailures = 1;
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_unverified" });
  const pending = store.get(before.thread)!;
  const target = recoveryIdentity({ ...pending, ...pending.pendingPreparation!.target }, store.installationId());
  const observed = launcherRecovery.queryContinuityTransaction(f.recoveryHost, target);
  expect(observed.state).toBe("prepared");
  expect(observed.preparationExpected).toEqual(recoveryIdentity({ ...pending, ...pending.pendingPreparation!.expected }, store.installationId()));
  store.completePreparation(before.thread, { scope: before!.scope, expectedVersion: pending.version }, pending.pendingPreparation!.preparationId);
  store.retireAttempt(before.thread, { scope: before!.scope }, before.currentWorkId!, before.works[before.currentWorkId!]!.attempts.at(-1)!.attempt);
  const retired = await launcherRecovery.retireContinuityWriter(f.recoveryHost, target);
  expect(retired.writerRetired).toBe(true);
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = store.get(before.thread)!;
  expect(after.pendingPreparation).toBeUndefined();
  expect(after.works[before.currentWorkId!]).toBeUndefined();
  expect(after.works[after.currentWorkId!]!.attempts).toHaveLength(1);
  expect(after.epoch).not.toBe(before.epoch);
  expect(f.controls.actualAcquisitions).toBe(1);
  expect(f.submissions).toHaveLength(1);
});

test.skipIf(continuityProcessInstance().startIdentity === "unverified")("page lifecycle process: unknown replacement Launcher admits a new page while the old process remains live", async () => {
  const launcher = Bun.spawn([process.execPath, "-e", `import {continuityProcessInstance} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))}; console.log(JSON.stringify(continuityProcessInstance())); setInterval(()=>{},1000);`], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(async () => { launcher.kill(); await launcher.exited; });
  const reader = launcher.stdout.getReader();
  const output = await reader.read(); reader.releaseLock();
  const processIdentity = JSON.parse(new TextDecoder().decode(output.value));
  const oldInstance = { pid: processIdentity.pid, startIdentity: processIdentity.startIdentity, instanceId: "c".repeat(64) };
  const { f, store, before } = await preparedMigrationFixture(false, oldInstance);
  f.controls.prepareBeforeFailures = 1;
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_unverified" });
  const pending = store.get(before.thread)!;
  // A replacement host's empty table cannot prove that its live predecessor has
  // no page. The child is a real process; browser surfaces remain test fixtures.
  const host = f.recoveryHost as typeof f.recoveryHost & { continuityTransactions: Map<string, unknown>; continuityTransactionReceipts: Map<string, unknown> };
  host.turnTabs.clear(); host.continuityTransactions.clear(); host.continuityTransactionReceipts.clear();
  const current = continuityProcessInstance();
  const newInstance = { pid: current.pid, startIdentity: current.startIdentity, instanceId: "d".repeat(64) };
  f.descriptor.pid = newInstance.pid;
  f.descriptor.launcherInstance = newInstance; host.continuityLauncherInstance = newInstance;
  writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = store.get(before.thread)!;
  expect(after.pendingPreparation).toBeUndefined();
  expect(after.works[before.currentWorkId!]).toBeUndefined();
  expect(after.works[after.currentWorkId!]!.attempts).toHaveLength(1);
  expect(after.epoch).not.toBe(before.epoch);
  expect(() => store.assertExecutionAuthority(recoveryRuntime.recoveryIdentity(pending, store.installationId()))).toThrow();
  expect(f.controls.actualAcquisitions).toBe(1);
  expect(f.submissions).toHaveLength(1);
  launcher.kill(); await launcher.exited;
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(store.get(before.thread)).toEqual(after);
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`unified recovery: Fresh chooses a cold full input and exact replay keeps it (${manual})`, async () => {
  const f = fixture(manual);
  f.provider.chatgptWeb!.experimentalFreshConversationPerTurn = true;
  const first = f.request("First task text must remain in the cold input.");
  await f.run(first);
  const next = f.next(first);
  const result = await f.run(next);
  expect(result.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.reused).toBe(false);
  expect(f.submissions[1]!.prompt).toContain("First task text must remain in the cold input.");
  expect(f.submissions[1]!.prompt).toContain("Completed response 1.");
  expect(f.submissions[1]!.key).not.toBe(f.submissions[0]!.key);
  expect(await f.run(structuredClone(next))).toEqual(result);
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) for (const reason of ["Fresh", "single-input-limit"] as const)
for (const wait of ["source-sync", "capacity"] as const) test(`ordinary cold preflight: stale ${reason} ${wait} preserves the newer writer (${manual})`, async () => {
  const f = fixture(manual);
  f.provider.chatgptWeb!.experimentalFreshConversationPerTurn = reason === "Fresh";
  const first = f.request();
  await f.run(first);
  const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId);
  const binding = bindings.observed(thread)!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  const sync = source.runtime.syncContextUsage;
  const preflightInput = continuityInput.preflightContinuityInput;
  const budgetCheck = reason === "single-input-limit" ? spyOn(continuityInput, "preflightContinuityInput").mockImplementation((...args) => {
    if (args[3] && args[4]?.retainedTokens !== undefined) {
      throw Object.assign(new Error("The fixture retained input exceeds its single-message limit."), { code: "continuity_input_limit" });
    }
    return preflightInput(...args);
  }) : undefined;
  let entered!: () => void, release!: () => void, started!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const holding = new Promise<void>(resolve => { release = resolve; });
  const starting = new Promise<void>(resolve => { started = resolve; });
  let observations = 0;
  const pauseFirst = async () => { if (++observations === 1) { entered(); await holding; } };
  if (wait === "capacity") f.controls.onCapacityQuery = pauseFirst;
  source.runtime.syncContextUsage = async () => {
    await sync?.call(source.runtime);
    if (wait === "source-sync") await pauseFirst();
  };
  const stale = f.run(f.next(first, "turn-stale")).catch(error => ({ code: (error as { code?: string }).code }));
  let newer: Promise<AdapterEvent[]> | undefined;
  let finishedNewer = false;
  const finishNewer = () => {
    if (!newer || finishedNewer) return;
    finishedNewer = true;
    if (manual) f.broker.completeSafeTurn(f.controls.safeToken, "The newer task completed.");
    else f.controls.releaseDeferredCompletion?.();
  };
  try {
    expect(await Promise.race([entering.then(() => true), stale.then(() => false)])).toBe(true);
    f.controls.deferCompletion = true;
    f.controls.onStarted = started;
    newer = f.run(f.next(first, "turn-newer"));
    expect(await Promise.race([starting.then(() => true), newer.then(() => false)])).toBe(true);
    const before = bindings.recoveryStore.get(thread)!;
    const workId = before.currentWorkId!;
    expect(before.works[workId]).toMatchObject({ nativeTurnId: "turn-newer", state: "active" });
    expect(before.works[workId]!.attempts.at(-1)!.writerRetired).toBe(false);
    const active = chatGptTurnSessions.find(bindings.observed(thread)!.executionKey!)!;
    expect(active.isActive()).toBe(true);
    release();
    const rejected = await stale;
    expect(Array.isArray(rejected) ? rejected.at(-1) : rejected).toMatchObject({ code: "continuity_source_unproven" });
    const after = bindings.recoveryStore.get(thread)!;
    expect(after).toEqual(before);
    expect(after.works[workId]!.attempts.at(-1)!.writerRetired).toBe(false);
    expect(active.isActive()).toBe(true);
    expect(active.settledOutcome()).toBeUndefined();
    finishNewer();
    expect((await newer).at(-1)).toMatchObject({ type: "done", endTurn: true });
    const completed = bindings.recoveryStore.get(thread)!;
    expect(completed.currentWorkId).toBe(workId);
    expect(completed.works[workId]!.state).toBe("completed");
    expect(completed.works[workId]!.attempts.at(-1)!.stage).toBe("completed");
    expect(active.settledOutcome()).toMatchObject({ type: "final" });
    expect(f.submissions).toHaveLength(2);
    expect(f.submissions[1]!.reused).toBe(false);
  } finally {
    release();
    try { finishNewer(); } catch { /* A failing race assertion can leave the test writer revoked. */ }
    await Promise.allSettled([stale, ...(newer ? [newer] : [])]);
    source.runtime.syncContextUsage = sync;
    f.controls.onCapacityQuery = undefined;
    budgetCheck?.mockRestore();
  }
}, 30_000);

for (const checkpoint of [false, true]) test(`unified recovery: an oversized real tool source survives fault loss and is read from the actual new entry (checkpoint=${checkpoint})`, async () => {
  const f = fixture();
  let original = f.request("Continue this accepted task after reading the stored log tail.");
  if (checkpoint) {
    f.controls.invokeSourceTools = true;
    const sourceEvents = await f.run(original);
    const sourceCall = sourceEvents.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
    const compact = f.request("", "turn-first", [...(original._rawBody as { input: unknown[] }).input,
      currentRecordedCall(f.provider, original),
      { type: "function_call_output", call_id: sourceCall.id, output: "Completed original checkpoint source call." }]);
    compact._compactionRequest = true;
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
    original = f.request("", "turn-first", [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }]);
  }
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true; f.controls.failAfterToolsOnce = true;
  const firstEvents = await f.run(original);
  const call = firstEvents.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!;
  const tail = "UNREAD_TAIL_6F81A9C2";
  const log = "original tool evidence line\n".repeat(80_000) + tail;
  const input = [...(original._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: call.id, output: log }];
  expect((await f.run(f.request("", "turn-first", input))).at(-1)).toMatchObject({ type: "error" });
  expect(store.get(thread)).toBeUndefined();
  f.controls.invokeSourceTools = false;
  let readBody = "";
  f.automatic.mockImplementationOnce(async turn => {
    expect(turn.continuity!.expected).toBeUndefined();
    const lease = { owner: turn.continuity!.owner, leaseId: "b".repeat(32), traceId: turn.traceId,
      recovery: turn.continuity!.recovery };
    f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    const compiled = await turn.prepare();
    expect(compiled.text).not.toContain(tail);
    await turn.onContextPlanSelected!(compiled.contextPlan!.planId);
    f.submissions.push({ prompt: compiled.text, claim: turn.continuity!, key: turn.conversationKey!, reused: false });
    await turn.onSendActivated!(); await turn.onSubmitted!();
    const required = await f.readStartup(compiled.text);
    expect(JSON.stringify(required)).toContain("Continue this accepted task after reading the stored log tail.");
    const entry = JSON.parse(compiled.text.match(/<codex_bootstrap_json>\n([^\n]+)\n/)![1]!);
    const credential = entry.first_call.arguments;
    const query = async (method: "search" | "read", args: Record<string, unknown>) => {
      const reply = await callTurnBroker<{ result: BrokerToolResult; receiptId: string }>(f.provider.chatgptWeb!.brokerSocketPath!, {
        method: "context_query", token: credential.turn_token, contract: "native", credentialKind: "ordinary", contextProtocol: CONTEXT_PROTOCOL_VERSION,
        contextBootstrapProtocol: "context-bootstrap-v1", contextReuseProtocol: "context-reuse-v1",
        contextMethod: method, contextArgs: { context_id: credential.context_id, ...args } as import("../src/adapters/chatgpt-web/context-runtime").ContextArgs,
      });
      expect(reply.result.isError).not.toBe(true);
      const { contextTextReadReceipt } = await import("../src/adapters/chatgpt-web/context-text-result");
      await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, { method: "context_return", token: credential.turn_token,
        contract: "native", credentialKind: "ordinary", contextProtocol: CONTEXT_PROTOCOL_VERSION, receiptId: reply.receiptId, sent: true,
        ...(method === "read" ? { textReadReceipt: contextTextReadReceipt(reply.result) } : {}) });
      return reply.result;
    };
    const found = (await query("search", { query: tail })).structuredContent as { hits: Array<{ read_ref: string; read_cursor: string }> };
    expect(found.hits).toHaveLength(1);
    const read = await query("read", { reads: [{ read_ref: found.hits[0]!.read_ref, cursor: found.hits[0]!.read_cursor }] });
    const { parseContextTextReadResult } = await import("../src/adapters/chatgpt-web/context-text-result");
    const page = parseContextTextReadResult(read);
    expect(page.bodies).toHaveLength(1);
    readBody = page.bodies[0]!;
    expect(readBody).toContain(tail);
    f.pages.get(turn.conversationKey!)!.state = "ready";
    turn.onTextDelta("Continued from the real stored tail.");
    return "Continued from the real stored tail.";
  });
  const recovered = await f.run(f.request("", "turn-first", input));
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(recovered.some(event => event.type === "tool_call_start")).toBe(false);
  expect(readBody).toContain(tail);
  const after = store.get(thread)!;
  expect(after.epoch).not.toBe(before.epoch);
  expect(after.works[before.currentWorkId!]).toBeUndefined();
  expect(after.calls).toEqual({});
  expect(f.submissions).toHaveLength(checkpoint ? 4 : 2);
}, 30_000);

test("unified recovery: long assistant history is optional on a replacement page", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true; f.controls.failAfterToolsOnce = true;
  const original = f.request();
  const events = await f.run(original);
  const call = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const input = [...(original._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: call.id, output: "The actual completed return." }];
  await f.run(f.request("", "turn-first", input));
  f.controls.invokeSourceTools = false;
  const oversized = f.request("", "turn-first", [...input,
    { type: "message", role: "assistant", content: "Optional assistant source text. ".repeat(60_000) }]);
  expect((await f.run(oversized)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions.at(-1)!.prompt).not.toContain("Optional assistant source text.");
  expect(JSON.stringify(taskEnvelope(f.submissions.at(-1)!.prompt))).not.toContain("Optional assistant source text.");
}, 30_000);

for (const manual of [false, true]) for (const checkpoint of [false, true]) test(`review repair1: persistent inspection failure isolates the old writer and admits one cold successor (${manual}, checkpoint=${checkpoint})`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.repeatManualSourceTool = manual && checkpoint;
  f.controls.singleSourceTool = !checkpoint;
  const source = f.request("Continue the accepted source after an inspection failure.");
  const issued = await f.run(source);
  const call = issued.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  let next = f.request("", "turn-first", [...(source._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: call.id, output: "The actual settled command return." }]);
  if (checkpoint) {
    const compact = f.request("", "turn-first", [...(source._rawBody as { input: unknown[] }).input,
      currentRecordedCall(f.provider, source),
      { type: "function_call_output", call_id: call.id, output: "The actual settled command return." }]);
    compact._compactionRequest = true;
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing accepted checkpoint");
    next = f.request("", "turn-first", [...(source._rawBody as { input: unknown[] }).input,
      { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }]);
  }
  f.controls.invokeSourceTools = false;
  f.controls.repeatManualSourceTool = false;
  f.controls.retirementCleanup = "pending";
  f.controls.inspectFailures = 100;
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!;
  const previousSubmissions = f.submissions.length;
  const result = await f.run(structuredClone(next));
  expect(result.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(previousSubmissions + 1);
  expect(f.submissions.at(-1)!.reused).toBe(false);
  expect(f.submissions.at(-1)!.prompt).toContain("Continue the accepted source after an inspection failure.");
  const after = store.get(thread)!;
  expect(after.epoch).not.toBe(before.epoch);
  expect(after.works[before.currentWorkId!]).toBeUndefined();
  expect(after.calls).toEqual({});
  expect(Object.values(after.works).flatMap(work => work.attempts)).toHaveLength(1);
  expect(result.filter(event => event.type === "text_delta" && event.text.includes("Previous project permissions were revoked"))).toHaveLength(1);
  f.controls.inspectFailures = 0;
  expect(await f.run(structuredClone(next))).toEqual(result);
  expect(f.submissions).toHaveLength(previousSubmissions + 1);
}, 30_000);

for (const ordinaryRounds of [1, 2]) test(`healthy checkpoints retain their page across short continuations without accumulating work reserves (${ordinaryRounds})`, async () => {
  const f = fixture();
  const instruction = "Repeat the same continuity instruction.";
  const first = f.request(instruction);
  await f.run(first);
  const firstCompact = structuredClone(first); firstCompact._compactionRequest = true;
  const firstCheckpointEvents = await f.run(firstCompact);
  const summary = firstCheckpointEvents.find(event => event.type === "text_delta" && event.phase === "final_answer");
  if (summary?.type !== "text_delta") throw new Error("Missing first actual checkpoint");
  const physicalKey = f.submissions[0]!.key;
  expect(f.submissions[1]!.key).toBe(physicalKey);
  let input: unknown[] = [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }];
  let current!: CodexParsedRequest;
  for (let index = 0; index < ordinaryRounds; index++) {
    const turnId = `turn-budget-${index}`;
    current = f.request("", turnId, [...input, { type: "message", role: "user", id: `msg-budget-${index}`, content: instruction,
      internal_chat_message_metadata_passthrough: { turn_id: turnId } }]);
    const events = await f.run(current);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(f.submissions.at(-1)!.key).toBe(physicalKey);
    expect(f.submissions.at(-1)!.reused).toBe(true);
    const answer = events.find(event => event.type === "text_delta" && event.phase === "final_answer");
    if (answer?.type !== "text_delta") throw new Error("Missing actual ordinary answer");
    input = [...(current._rawBody as { input: unknown[] }).input,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: answer.text }] }];
  }
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!;
  const sourceWork = before.works[before.currentWorkId!]!;
  const secondCompact = structuredClone(current); secondCompact._compactionRequest = true;
  const checkpointEvents = await f.run(secondCompact);
  expect(checkpointEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const secondPage = f.submissions.at(-1)!;
  expect(secondPage.reused).toBe(true);
  expect(secondPage.key).toBe(physicalKey);
  const after = store.get(thread)!;
  const checkpoint = Object.values(after.checkpoints).find(value => value.targetHistoryRevision === 2)!;
  expect(checkpoint.sourceLogicalWorkId).toBe(sourceWork.logicalWorkId);
  expect(checkpoint.acceptedTaskRevision).toBe(sourceWork.acceptedTaskRevision);
  expect(after.historyRevision).toBe(2);
  expect(after.epoch).toBe(before.epoch);
  const compactWork = after.works[`compaction:${checkpoint.compactionTargetId}`]!;
  expect(compactWork.attempts).toHaveLength(1);
  expect(compactWork.state).toBe("completed");
  const sends = f.submissions.length;
  const replay = await f.run(structuredClone(secondCompact));
  expect(replay.filter(event => event.type === "text_delta" && event.phase === "final_answer"))
    .toEqual(checkpointEvents.filter(event => event.type === "text_delta" && event.phase === "final_answer"));
  expect(replay.at(-1)).toEqual(checkpointEvents.at(-1));
  expect(f.submissions).toHaveLength(sends);
  const acceptedSummary = checkpointEvents.find(event => event.type === "text_delta" && event.phase === "final_answer");
  if (acceptedSummary?.type !== "text_delta") throw new Error("Missing second actual checkpoint");
  const newWork = f.request("", "turn-after-budget-checkpoint", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(acceptedSummary.text) },
    { type: "message", role: "user", id: "msg-after-budget-checkpoint", content: "Continue with new work after the actual checkpoint.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-after-budget-checkpoint" } },
  ]);
  expect((await f.run(newWork)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions.at(-1)!.key).toBe(secondPage.key);
  expect(f.submissions.at(-1)!.reused).toBe(true);
  expect(f.submissions.at(-1)!.prompt).not.toContain(acceptedSummary.text);
}, 30_000);

test("review repair1: persistent inspection failure revokes an unknown Send before current-request recovery", async () => {
  const f = fixture();
  const original = f.request();
  f.automatic.mockImplementationOnce(async turn => {
    const lease = { owner: turn.continuity!.owner, leaseId: "d".repeat(32), traceId: turn.traceId,
      recovery: turn.continuity!.recovery };
    f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    const compiled = await turn.prepare();
    if (compiled.contextPlan) await turn.onContextPlanSelected!(compiled.contextPlan.planId);
    f.submissions.push({ prompt: compiled.text, claim: turn.continuity!, key: turn.conversationKey!, reused: false });
    await turn.onSendActivated!();
    throw continuityError("continuity_unverified", "The original Send has no submission receipt.");
  });
  await f.run(original);
  const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId);
  const binding = bindings.observed(thread)!;
  binding.state = "unverified";
  f.controls.inspectFailures = 100;
  const before = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  expect((await f.run(structuredClone(original))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const record = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  expect(record.works[record.currentWorkId!]!.attempts).toHaveLength(1);
  expect(record.works[record.currentWorkId!]!.attempts[0]!.stage).toBe("completed");
  expect(record.works[before.currentWorkId!]).toBeUndefined();
  expect(record.epoch).not.toBe(before.epoch);
  expect(f.submissions).toHaveLength(2);
});

for (const barrier of ["missing-result", "explicit-stop", "old-protocol"] as const) test(`review repair1: unknown page handles current request with ${barrier}`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true;
  const source = f.request();
  const issued = await f.run(source);
  const call = issued.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  const next = f.request("", "turn-first", [...(source._rawBody as { input: unknown[] }).input,
    ...(barrier === "missing-result" ? [] : [{ type: "function_call_output", call_id: call.id, output: "The actual completed return." }])]);
  const thread = continuityDigest(f.threadId), bindings = continuityBindingsFor(f.statePath);
  const binding = bindings.observed(thread)!;
  const store = new ContinuityRecoveryStore(f.statePath), before = store.get(thread)!;
  binding.state = "unverified";
  f.controls.invokeSourceTools = false; f.controls.inspectFailures = 100;
  if (barrier === "explicit-stop") store.stopWork(thread, { scope: before!.scope }, before.currentWorkId!, "user-stop");
  if (barrier === "old-protocol") {
    f.descriptor.features = f.descriptor.features.filter(feature => feature !== CONTINUITY_EXECUTION_FENCING_FEATURE);
    writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
  }
  if (barrier === "old-protocol") {
    await expect(f.run(next)).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
    expect(store.get(thread)).toBeUndefined();
    expect(f.submissions).toHaveLength(1);
  } else {
    expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    const after = store.get(thread)!;
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.works[before.currentWorkId!]).toBeUndefined();
    expect(after.calls).toEqual({});
    expect(f.submissions).toHaveLength(2);
  }
}, 30_000);

for (const manual of [false, true]) test(`completed replay: ${manual ? "Zero Risk" : "Automatic"} remote unfinished retirement preserves the submitted failure`, async () => {
  const f = fixture(manual);
  let started!: () => void, entered!: () => void, release!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const replying = new Promise<void>(resolve => { release = resolve; });
  f.controls.onStarted = started; f.controls.deferCompletion = true;
  const parsed = f.request(), original = f.adapter(), abort = new AbortController();
  await original.preflight!(parsed, { headers: new Headers() });
  const detached = original.runTurn!(parsed, { headers: new Headers(), abortSignal: abort.signal }, () => {}).catch(error => error);
  await starting; abort.abort();
  expect(await detached).toMatchObject({ name: "AbortError" });
  const remote = new RemoteTurnBroker(f.broker.socketPath);
  const originalUpdate = remote.updateEnvironment.bind(remote);
  const update = spyOn(remote, "updateEnvironment").mockImplementation(async (...args) => {
    entered(); await replying; return originalUpdate(...args);
  });
  cleanups.push(async () => { release(); update.mockRestore(); });
  const adapter = createChatGptWebAdapter(f.provider, { broker: remote, zeroRiskManualControl: f.manualControl });
  const events: AdapterEvent[] = [];
  await adapter.preflight!(parsed, { headers: new Headers() });
  const reconnect = adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event)).catch(error => error);
  await entering;
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), record = store.get(thread)!;
  const work = record.works[record.currentWorkId!]!;
  expect(work.state).toBe("active");
  store.retireAttempt(thread, { scope: record.scope }, work.logicalWorkId, work.attempts.at(-1)!.attempt);
  release();
  expect(await reconnect).toBeUndefined();
  expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "chatgpt_submitted_turn_failed", retryable: false });
  expect(events.some(event => event.type === "done")).toBe(false);
  expect(f.submissions).toHaveLength(1);
  expect(update).toHaveBeenCalledTimes(1);
});

for (const recovered of [false, true]) for (const boundary of ["same-work", "new-owner", "stale-observer", "broken-predecessor"] as const) test(`completed append reconnect across owner RPC: recovery=${recovered}, ${boundary}`, async () => {
  const f = fixture(false, { taskUpdates: true });
  if (recovered) {
    f.controls.failAfterSendOnce = true;
    expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "error" });
    expect(new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))).toBeUndefined();
  }
  f.controls.invokeSourceTools = true;
  f.controls.nativeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.pauseAfterToolResults = true;
  const initial = f.request();
  const opening = await f.run(initial);
  const call = opening.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
  expect(call).toBeDefined();
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  expect(source.runtime.recoveryOrigin?.attempt).toBe(0);
  if (recovered) expect(binding.recovery!.logicalWorkId).not.toBe(f.submissions[0]!.claim.recovery!.logicalWorkId);
  const text = "Keep the newly accepted review constraint.";
  const update = { revision: 1, sourceMessageId: "review-append-B", content: text, payloadDigest: recoveryDigest(text) };
  f.controls.acknowledgePendingUpdate = update;
  const next = f.request("", "turn-first", [
    ...(initial._rawBody as { input: unknown[] }).input,
    recordedCall(source.outstanding()[0]!),
    { type: "function_call_output", call_id: call!.id, output: "Exact result before the new instruction." },
    { type: "message", id: update.sourceMessageId, role: "user", content: text,
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first", content_item_kinds: ["user.text"] } },
  ]);
  const firstObserver = f.adapter(), abort = new AbortController();
  await firstObserver.preflight!(next, { headers: new Headers() });
  let observerEnded = false;
  const firstEvents: AdapterEvent[] = [];
  const firstRun = firstObserver.runTurn!(next, { headers: new Headers(), abortSignal: abort.signal }, event => firstEvents.push(event))
    .then(() => { observerEnded = true; }, error => { observerEnded = true; return error; });
  const until = async (condition: () => boolean, label: string) => {
    const end = Date.now() + 10_000;
    while (!condition() && Date.now() < end) await Bun.sleep(5);
    if (!condition()) throw new Error(`Probe did not reach ${label}; events=${JSON.stringify(firstEvents)}`);
  };
  let releaseInspection!: () => void, inspectionEntered!: () => void;
  const inspected = new Promise<void>(resolve => { inspectionEntered = resolve; });
  f.controls.completionInspection = { entered: inspectionEntered, release: new Promise<void>(resolve => { releaseInspection = resolve; }) };
  let releaseRpc!: () => void, rpcEntered!: () => void, rpcRejected!: () => void;
  const rpcGate = new Promise<void>(resolve => { releaseRpc = resolve; });
  const entered = new Promise<void>(resolve => { rpcEntered = resolve; });
  const rejected = new Promise<void>(resolve => { rpcRejected = resolve; });
  const remote = new RemoteTurnBroker(f.broker.socketPath);
  const updateEnvironment = remote.updateEnvironment.bind(remote);
  const rpc = spyOn(remote, "updateEnvironment").mockImplementation(async (...args) => {
    rpcEntered(); await rpcGate;
    try { return await updateEnvironment(...args); }
    catch (error) { rpcRejected(); throw error; }
  });
  cleanups.push(async () => { releaseRpc(); releaseInspection(); rpc.mockRestore(); });
  try {
    await until(() => Boolean(f.controls.releaseAfterToolResults) || observerEnded, "accepted append tool settlement");
    if (observerEnded) throw new Error(`Append ended unexpectedly: ${JSON.stringify(await firstRun)} ${JSON.stringify(firstEvents)}`);
    expect(binding.recovery!.attempt).toBe(0);
    expect(binding.recovery!.logicalWorkId).not.toBe(source.runtime.recoveryOrigin!.logicalWorkId);
    abort.abort();
    expect(await firstRun).toMatchObject({ name: "AbortError" });
    const reconnectAdapter = createChatGptWebAdapter(f.provider, { broker: remote, zeroRiskManualControl: f.manualControl });
    await reconnectAdapter.preflight!(next, { headers: new Headers() });
    const events: AdapterEvent[] = [];
    const reconnect = reconnectAdapter.runTurn!(next, { headers: new Headers() }, event => events.push(event)).catch(error => error);
    await entered;
    f.controls.releaseAfterToolResults!();
    await inspected;
    const record = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
    expect(record.works[record.currentWorkId!]!.state).toBe("completed");
    const ref = binding.recovery!, work = record.works[ref.logicalWorkId]!;
    const store = new ContinuityRecoveryStore(f.statePath);
    if (boundary === "new-owner") {
      store.transact(record.thread, { scope: record.scope, expectedVersion: record.version }, draft => {
        draft.owner = { ...draft.owner, id: recoveryDigest("replacement-owner") };
      });
      await until(() => continuityBindingsFor(f.statePath).observed(record.thread) !== binding, "old owner cleanup notification");
    } else if (boundary === "stale-observer") {
      // A later accepted route owns the binding, even if the old route remains in the session.
      binding.logicalExecutionKey = `${chatGptWebExecutionNamespace(f.provider)}:later-request`;
    } else if (boundary === "broken-predecessor") {
      // Matching revision and generation alone cannot prove the retained physical source.
      const get = ContinuityRecoveryStore.prototype.get;
      const read = spyOn(ContinuityRecoveryStore.prototype, "get").mockImplementation(function (this: ContinuityRecoveryStore, thread) {
        const observed = get.call(this, thread);
        if (observed?.works[ref.logicalWorkId]?.state === "completed") {
          delete observed.works[ref.logicalWorkId]!.predecessorLogicalWorkId;
        }
        return observed;
      });
      cleanups.push(async () => { read.mockRestore(); });
    }
    releaseRpc();
    await rejected;
    releaseInspection();
    const error = await reconnect;
    const originalOutcome = await source.browserOutcome;
    await source.physicalSettlement;
    if (boundary === "new-owner") expect(originalOutcome).toMatchObject({
      type: "error", error: { code: "continuity_recovery_retired" },
    });
    else expect(originalOutcome).toEqual({ type: "final", answer: "Stopped at the accepted tool boundary." });
    expect(work.terminalDigest).toBe(recoveryDigest("Stopped at the accepted tool boundary."));
    if (boundary === "same-work") {
      expect(error).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")
        .map(event => event.type === "text_delta" ? event.text : "").join("")).toBe(originalOutcome.type === "final" ? originalOutcome.answer : "");
    } else {
      if (boundary === "new-owner") {
        expect(error).toBeUndefined();
        expect(events.at(-1)).toMatchObject({ type: "error", code: "chatgpt_submitted_turn_failed", status: 502, retryable: false });
      } else expect(error).toMatchObject({ code: "continuity_source_unproven", status: 409 });
      expect(events.some(event => event.type === "done" || event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
    }
    expect(f.submissions).toHaveLength(recovered ? 2 : 1);
  } finally {
    releaseRpc(); releaseInspection(); abort.abort(); f.controls.releaseAfterToolResults?.();
    await firstRun;
  }
}, 30_000);
