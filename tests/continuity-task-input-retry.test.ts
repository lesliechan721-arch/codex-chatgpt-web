import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityRecoveryStore, continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { beginRecoverySend, recoveryContext, recoveryIdentity, recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { parseRequest } from "../src/responses/parser";
import { callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { ContinuityTaskInputStore } from "../src/adapters/chatgpt-web/continuity-task-input-store";
import { taskUpdateDigest } from "../src/adapters/chatgpt-web/task-update-source";
import { taskInputControl } from "../src/task-input-control";
import { createSessionContinuityFixtures, currentRecordedCall, launcherRecovery, recordedCall } from "./helpers/session-continuity-fixture";
import { harmlessContinuityCommand } from "./helpers/continuity-command";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { AdapterEvent } from "../src/types";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

const { fixture, disposeTestFixtures } = createSessionContinuityFixtures(import.meta.path);
const roots: string[] = [];
afterEach(async () => { await disposeTestFixtures(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const confirmedUnsent of [false, true]) test(`queued initial delivery retries only after confirmed unsent preparation=${confirmedUnsent}`, async () => {
  const f = fixture(false, { taskUpdates: true });
  f.descriptor.features.push("preparation-termination-v1");
  writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor), { mode: 0o600 });
  f.controls.deferCompletion = true;
  const started = new Promise<void>(resolve => { f.controls.onStarted = resolve; });
  const original = f.request(), first = f.run(original).catch(error => error);
  await started;
  const continuation = () => f.request("", "turn-first", [
    ...(original._rawBody as { input: unknown[] }).input,
    { type: "message", id: "queued-preparation", role: "user", content: "Keep this exact queued instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first", content_item_kinds: ["user.text"] } },
  ]);
  const queued = f.run(continuation()).catch(error => error);
  const inbox = new ContinuityTaskInputStore(f.statePath);
  for (let i = 0; i < 200 && !inbox.listTasks().length; i++) await Bun.sleep(5);
  expect(inbox.listTasks()).toHaveLength(1);
  const normalRun = f.automatic.getMockImplementation()!;
  const failure = new ChatGptWebAdapterError("Controlled queued preparation failure", {
    code: "preparation_queued_fixture", status: 422, errorType: "invalid_request_error", retryable: false,
  });
  let attempts = 0;
  f.automatic.mockImplementation(async turn => {
    attempts++;
    const lease = { ...turn.continuity!.expected!, traceId: turn.traceId, recovery: turn.continuity!.recovery! };
    f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    if (confirmedUnsent) new ContinuityRecoveryStore(f.statePath).terminatePreparation(turn.continuity!.recovery!, {
      requestId: turn.recoveryRequestId!, traceId: turn.traceId, helperPid: process.pid, lease,
    });
    else await turn.onSendActivated!();
    throw failure;
  });
  f.controls.deferCompletion = false;
  f.controls.releaseDeferredCompletion?.();
  await first;
  expect((await queued).at(-1)).toMatchObject({ type: "error", code: failure.code, message: failure.message });
  const failedTask = inbox.listTasks()[0]!, failedMessage = failedTask.messages[0]!;
  expect(failedMessage).toMatchObject({ messageId: "queued-preparation", receivedSequence: 1, status: "accepted" });
  expect(failedTask.deliveries).toHaveLength(1);
  expect(failedTask.deliveries[0]!.cancelled === true).toBe(confirmedUnsent);
  expect(f.submissions).toHaveLength(1);
  f.automatic.mockImplementation(normalRun);
  const retry = await f.run(continuation());
  const after = inbox.listTasks()[0]!;
  expect(after.receivedSequence).toBe(1);
  expect(after.messages[0]!.messageId).toBe(failedMessage.messageId);
  expect(after.messages[0]!.digest).toBe(failedMessage.digest);
  expect(inbox.readBody(after, failedMessage.messageId)).toBe("Keep this exact queued instruction.");
  if (confirmedUnsent) {
    expect(retry.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(after.messages[0]!.status).toBe("completed");
    expect(after.deliveries).toHaveLength(2);
    expect(after.deliveries[1]!.completedMessageIds).toEqual([failedMessage.messageId]);
    expect(f.submissions).toHaveLength(2);
    expect(f.submissions[1]!.reused).toBe(true);
  } else {
    expect(retry.at(-1)).toMatchObject({ type: "error", code: failure.code });
    expect(after.deliveries).toEqual(failedTask.deliveries);
    expect(f.submissions).toHaveLength(1);
  }
  expect(attempts).toBe(1);
}, 20_000);

for (const failure of ["accepted", "late-result", "unknown-send", "later-input"] as const)
test(`queued initial delivery completes only after verified timeout recovery (${failure})`, async () => {
  const f = fixture(false, { taskUpdates: true });
  f.controls.actualRecovery = true;
  f.controls.deferCompletion = true;
  const started = new Promise<void>(resolve => { f.controls.onStarted = resolve; });
  const normalRun = f.automatic.getMockImplementation()!;
  // Model the Host's successful completion receipt so an ordinary continuation
  // can reuse the page before its later timeout requires a new transaction.
  const run: typeof normalRun = async turn => {
    const answer = await normalRun(turn);
    const tab = f.recoveryHost.turnTabs.get(turn.traceId)!;
    tab.status = "ready";
    launcherRecovery.completeContinuityTransaction(f.recoveryHost, tab, true);
    return answer;
  };
  f.automatic.mockImplementation(run);
  const original = f.request(), first = f.run(original);
  const inbox = new ContinuityTaskInputStore(f.statePath), recovery = new ContinuityRecoveryStore(f.statePath);
  await started;
  const input: unknown[] = [...(original._rawBody as { input: unknown[] }).input,
    { type: "message", id: "queued-timeout", role: "user", content: "Keep this queued instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first", content_item_kinds: ["user.text"] } }];
  const request = () => f.request("", "turn-first", structuredClone(input));
  const queued = f.run(request());
  for (let i = 0; i < 200 && !inbox.listTasks().length; i++) await Bun.sleep(5);
  expect(inbox.listTasks()).toHaveLength(1);
  const counter = join(f.statePath, "queued-command-count");
  const timeout = new ChatGptWebAdapterError("Message delivery timed out. Please try again.",
    { status: 503, errorType: "server_error", code: "chatgpt_delivery_timeout", retryable: true });
  f.automatic.mockImplementation(turn => {
    if (failure === "late-result") {
      f.controls.invokeSourceTools = f.controls.singleSourceTool = f.controls.nativeSourceTools = true;
      f.controls.command = harmlessContinuityCommand(counter, "late queued result");
      f.controls.beforeToolsResultFailure = timeout;
      f.controls.failAfterToolsKeepPage = true;
      return run(turn);
    }
    return run({ ...turn, onSubmitted: async () => {
      if (failure !== "unknown-send") await turn.onSubmitted?.();
      throw timeout;
    } });
  });
  f.controls.deferCompletion = false;
  f.controls.releaseDeferredCompletion?.();
  await first;
  const failed = await queued;
  const thread = continuityDigest(f.threadId), binding = continuityBindingsFor(f.statePath).observed(thread)!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  expect(await source.browserOutcome).toMatchObject({ type: "error", error: { code: timeout.code } });
  const before = inbox.listTasks()[0]!, workId = binding.recovery!.logicalWorkId;
  expect(before.deliveries).toHaveLength(1);
  expect(before.messages[0]!.status).toBe("accepted");
  expect(recovery.get(thread)!.works[workId]!.taskInputRetry).toBeUndefined();
  let laterInputBoundary = false;
  f.automatic.mockImplementation(turn => {
    if (failure === "later-input" && f.submissions.length === 3) {
      // The first recovered final must release only its own exact input prefix.
      const task = inbox.get(before)!;
      expect(task.messages.map(message => message.status)).toEqual(["completed", "accepted"]);
      expect(inbox.usage(before).pendingMessages).toBe(1);
      expect(task.deliveries.flatMap(delivery => delivery.completedMessageIds)).toEqual(["queued-timeout"]);
      laterInputBoundary = true;
    }
    return run({ ...turn, onSubmitted: async () => {
      await turn.onSubmitted?.();
      if (failure === "later-input" && f.submissions.length === 3) {
        // Receipt after this immutable prompt was sent belongs to a later response.
        inbox.receive(before, [{ messageId: "later-input", text: "Handle this input separately." }]);
      }
    } });
  });
  if (failure === "unknown-send") {
    expect(failed.at(-1)).toMatchObject({ type: "error", code: timeout.code });
    expect((await f.run(request())).at(-1)).toMatchObject({ type: "error", code: timeout.code });
    expect(recovery.get(thread)!.works[workId]!.attempts).toMatchObject([
      { sendEvidence: { status: "possible" }, writerRetired: false }]);
    expect(inbox.get(before)).toEqual(before);
    expect(f.submissions).toHaveLength(2);
    return;
  }
  if (failure === "late-result") {
    const call = failed.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
    expect(call).toBeDefined();
    input.push(recordedCall(source.outstanding()[0]!));
    await expect(f.run(request())).rejects.toMatchObject({ code: "continuity_execution_unsettled" });
    expect(recovery.get(thread)!.works[workId]!.attempts).toMatchObject([{ writerRetired: false }]);
    expect(inbox.get(before)!.deliveries).toEqual(before.deliveries);
    expect(f.submissions).toHaveLength(2);
    const executed = await $`${{ raw: f.controls.command }}`.quiet().nothrow();
    expect(executed.exitCode).toBe(0);
    input.push({ type: "function_call_output", call_id: call.id, output: executed.stdout.toString() });
    f.controls.invokeSourceTools = false;
  }
  const result = await f.run(request());
  expect(result.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(result.some(event => event.type === "tool_call_start")).toBe(false);
  expect((await f.run(request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const expectedSends = failure === "later-input" ? 4 : 3;
  expect(f.submissions).toHaveLength(expectedSends);
  expect(f.controls.actualAcquisitions).toBe(expectedSends);
  expect(recovery.get(thread)!.works[workId]).toMatchObject({ state: "completed",
    attempts: [{ writerRetired: true, sendEvidence: { status: "accepted" } }, { sendEvidence: { status: "accepted" } }] });
  const completed = inbox.get(before)!;
  expect(completed.state).toBe("completed");
  expect(completed.messages.every(message => message.status === "completed")).toBe(true);
  expect(completed.deliveries[0]).toEqual({ ...before.deliveries[0]!, completedMessageIds: ["queued-timeout"] });
  expect(completed.deliveries).toHaveLength(failure === "later-input" ? 2 : 1);
  if (failure === "later-input") {
    expect(laterInputBoundary).toBe(true);
    expect(completed.deliveries[1]).toMatchObject({ messageIds: ["later-input"], completedMessageIds: ["later-input"] });
  }
  expect(inbox.usage(before)).toMatchObject({ pendingMessages: 0, pendingBytes: 0 });
  expect(inbox.cleanup(before)!.messages[0]!.payload).toBe("released");
  if (failure === "late-result") expect(readFileSync(counter, "utf8")).toBe("x");
}, 20_000);

test("a deleted old source cannot inspect or retire a later active page", async () => {
  const f = fixture(false, { taskUpdates: true });
  const original = f.request("Original task.", "turn-deleted");
  await f.run(original);
  const thread = continuityDigest(f.threadId), recovery = new ContinuityRecoveryStore(f.statePath);
  const inbox = new ContinuityTaskInputStore(f.statePath);
  const identity = { thread, scope: recovery.get(thread)!.scope,
    taskId: `task_${taskUpdateDigest([thread, "turn-deleted"])}` };
  inbox.receive(identity, [{ messageId: "msg-turn-deleted", text: "Original task." }]);
  inbox.deleteTask(identity);
  f.controls.deferCompletion = true;
  const started = new Promise<void>(resolve => { f.controls.onStarted = resolve; });
  const successor = f.run(f.request("New active task.", "turn-current"));
  await started;
  const before = recovery.get(thread)!;
  const binding = continuityBindingsFor(f.statePath).observed(thread)!;
  const page = structuredClone(binding.lease);
  await expect(f.run(original)).rejects.toMatchObject({ code: "continuity_stopped" });
  expect(recovery.get(thread)).toEqual(before);
  expect(binding.lease).toEqual(page);
  expect(f.submissions).toHaveLength(2);
  f.controls.releaseDeferredCompletion?.();
  expect((await successor).at(-1)).toMatchObject({ type: "done", endTurn: true });
}, 15_000);

for (const pageLost of [false, true]) for (const retryOriginal of [false, true]) test(`stopped task retries once from current source, page lost=${pageLost}, original instruction=${retryOriginal}`, async () => {
  const f = fixture(false, { taskUpdates: true });
  f.controls.deferCompletion = true;
  const started = new Promise<void>(resolve => { f.controls.onStarted = resolve; });
  const original = f.request("Original instruction.", "turn-retry");
  const first = f.run(original).catch(error => error);
  await started;
  const thread = continuityDigest(f.threadId), recovery = new ContinuityRecoveryStore(f.statePath), inbox = new ContinuityTaskInputStore(f.statePath);
  const before = recovery.get(thread)!;
  const sourceId = before.currentWorkId!, sourceKey = continuityBindingsFor(f.statePath).observed(thread)!.executionKey;
  const identity = { thread, scope: before.scope, taskId: `task_${taskUpdateDigest([thread, "turn-retry"])}` };
  const selectedId = retryOriginal ? "msg-turn-retry" : "retry-message";
  inbox.receive(identity, [{ messageId: "msg-turn-retry", text: "Original instruction." },
    ...(!retryOriginal ? [{ messageId: "retry-message", text: "Continue the interrupted task." }] : [])]);
  inbox.stop(identity);
  const stopped = recovery.stopWork(thread, { scope: before.scope }, sourceId, "user-stop");
  const source = structuredClone(stopped.works[sourceId]);
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(1);
  if (pageLost) {
    f.pages.clear();
    expect(recovery.removePage(thread, stopped)).toBe(true);
  }
  await expect(f.run(f.request("Original instruction.", "turn-retry"))).rejects.toMatchObject({ code: "continuity_stopped" });
  const task = inbox.get(identity)!;
  expect(taskInputControl(f.statePath, { action: "retry", identity, messageIds: [selectedId],
    expectedVersion: task.version, expectedIntentGeneration: task.intentGeneration })).toEqual({ ok: true, value: null });
  // A UI action alone has no observer and cannot acquire a page or Send.
  expect(f.submissions).toHaveLength(1);
  expect(recovery.get(thread)?.epoch).toBe(pageLost ? undefined : before.epoch);
  if (!retryOriginal) await expect(f.run(f.request("Original instruction.", "turn-retry"))).rejects.toMatchObject({ code: "continuity_stopped" });
  const current = f.request("", "turn-retry", [
    ...(original._rawBody as { input: unknown[] }).input,
    ...(!retryOriginal ? [{ type: "message", id: "retry-message", role: "user", content: "Continue the interrupted task.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-retry" } }] : []),
  ]);
  if (pageLost && !retryOriginal) await expect(f.run(f.request("", "turn-retry", (current._rawBody as { input: unknown[] }).input.slice(1))))
    .rejects.toMatchObject({ code: "continuity_source_unproven" });
  if (pageLost) await expect(f.run(f.request("", "turn-retry", [
    ...(current._rawBody as { input: unknown[] }).input,
    { type: "function_call", call_id: "unsettled-history-call", name: "exec_command", arguments: '{"cmd":"historical-command"}' },
  ]))).rejects.toMatchObject({ code: "continuity_execution_unsettled" });
  f.controls.deferCompletion = false;
  const duplicate = f.request("", "turn-retry", structuredClone((current._rawBody as { input: unknown[] }).input));
  const [result, replay] = await Promise.all([f.run(current), f.run(duplicate)]);
  f.controls.releaseDeferredCompletion?.(); await first;
  expect(result.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  const after = recovery.get(thread)!;
  if (pageLost) {
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.works[sourceId]).toBeUndefined();
  } else {
    expect(after.epoch).toBe(before.epoch + 1);
    expect(after.works[sourceId]).toEqual(source);
  }
  expect(after.works[after.currentWorkId!]!.state).toBe("completed");
  expect(continuityBindingsFor(f.statePath).observed(thread)!.executionKey).not.toBe(sourceKey);
  expect(inbox.get(identity)!.messages.find(message => message.messageId === selectedId)!.status).toBe("completed");
  expect(() => inbox.assertExecutionIntent(identity, 0)).toThrow();
  await expect(callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, { method: "native_operation_start",
    token: f.submissions[0]!.turnToken!, contract: "native", nativeWaitProtocol: 1, taskUpdateProtocol: 1,
    operationId: 900, taskRevision: 0, entry: "codex_exec", nativeInput: { cmd: "old-intent-must-not-run" }, waitMs: 1 })).rejects.toThrow();
}, 15_000);

async function startExplicitRetry() {
  const f = fixture(false, { taskUpdates: true });
  f.controls.actualRecovery = true;
  f.controls.deferCompletion = true;
  const started = new Promise<void>(resolve => { f.controls.onStarted = resolve; });
  const original = f.request("Original instruction.", "turn-retry");
  const first = f.run(original).catch(error => error);
  await started;
  const thread = continuityDigest(f.threadId), recovery = new ContinuityRecoveryStore(f.statePath);
  const inbox = new ContinuityTaskInputStore(f.statePath), before = recovery.get(thread)!;
  const identity = { thread, scope: before.scope, taskId: `task_${taskUpdateDigest([thread, "turn-retry"])}` };
  inbox.receive(identity, [{ messageId: "msg-turn-retry", text: "Original instruction." }]);
  inbox.stop(identity);
  recovery.stopWork(thread, { scope: before.scope }, before.currentWorkId!, "user-stop");
  const task = inbox.get(identity)!;
  expect(taskInputControl(f.statePath, { action: "retry", identity, messageIds: ["msg-turn-retry"],
    expectedVersion: task.version, expectedIntentGeneration: task.intentGeneration })).toEqual({ ok: true, value: null });
  f.controls.deferCompletion = false;
  return { f, original, thread, recovery, inbox, identity, first };
}

for (const pageState of ["ready", "running"] as const) for (const interleaved of [false, true])
test(`explicit task retry recovers its accepted input and real result once (page=${pageState}, interleaved=${interleaved})`, async () => {
  const { f, original, thread, recovery, inbox, identity, first } = await startExplicitRetry();
  f.controls.invokeSourceTools = f.controls.singleSourceTool = f.controls.nativeSourceTools = true;
  f.controls.failAfterToolsOnce = f.controls.failAfterToolsKeepPage = true;
  f.controls.afterToolsFailure = new ChatGptWebAdapterError("Message delivery timed out. Please try again.",
    { status: 503, errorType: "server_error", code: "chatgpt_delivery_timeout", retryable: true });
  const counter = join(f.statePath, "retry-command-count");
  f.controls.command = harmlessContinuityCommand(counter, "actual explicit retry result");
  const explicit = f.request("Original instruction.", "turn-retry");
  const events = await f.run(explicit);
  const call = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  expect(call).toBeDefined();
  const executed = await $`${{ raw: f.controls.command }}`.quiet().nothrow();
  expect(executed.exitCode, executed.stderr.toString()).toBe(0);
  const stdout = executed.stdout.toString();
  const result = { type: "function_call_output", call_id: call.id, output: stdout };
  const input = [...(original._rawBody as { input: unknown[] }).input, currentRecordedCall(f.provider, explicit), result];
  expect((await f.run(f.request("", "turn-retry", input))).at(-1)).toMatchObject({ type: "error", code: "chatgpt_delivery_timeout" });
  f.controls.invokeSourceTools = false;
  f.controls.releaseDeferredCompletion?.(); await first;
  const before = recovery.get(thread)!, work = before.works[before.currentWorkId!]!;
  expect(work.attempts.at(-1)!.sendEvidence?.status).toBe("accepted");
  expect(before.calls[call.id]!.state).toBe("settled");
  const accepted = inbox.get(identity)!;
  expect(accepted.deliveries).toHaveLength(1);
  expect(accepted.messages[0]!.status).toBe("accepted");
  for (const page of f.pages.values()) page.state = pageState;
  const binding = continuityBindingsFor(f.statePath).observed(thread)!;
  const oldTab = f.recoveryHost.turnTabs.get(binding.lease!.traceId)!;
  oldTab.status = pageState;
  if (interleaved) await expect(f.run(f.next(original))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  // A conflicting result cannot replace the accepted return or retire its writer.
  await expect(f.run(f.request("", "turn-retry", [...input.slice(0, -1), { ...result, output: "conflicting result" }])))
    .rejects.toMatchObject({ code: "continuity_result_conflict" });
  expect(f.submissions).toHaveLength(2);
  expect(recovery.get(thread)!.works[work.logicalWorkId]!.attempts[0]!.writerRetired).toBe(false);
  const recovered = await f.run(f.request("", "turn-retry", input));
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(recovered.some(event => event.type === "tool_call_start")).toBe(false);
  expect((await f.run(f.request("", "turn-retry", input))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[2]!.prompt).toContain(stdout);
  expect(readFileSync(counter, "utf8")).toBe("x");
  expect(f.controls.actualAcquisitions).toBe(3);
  expect(oldTab.destroyed).toBe(true);
  const after = recovery.get(thread)!.works[work.logicalWorkId]!;
  expect(after.attempts).toHaveLength(2);
  expect(after.attempts[0]!.writerRetired).toBe(true);
  expect(after.state).toBe("completed");
  const completed = inbox.get(identity)!;
  expect(completed.intentGeneration).toBe(accepted.intentGeneration);
  expect(completed.state).toBe("completed");
  expect(completed.messages[0]!.status).toBe("completed");
  expect(completed.deliveries).toEqual([{ ...accepted.deliveries[0]!,
    deliveredMessageIds: ["msg-turn-retry"], completedMessageIds: ["msg-turn-retry"] }]);
}, 20_000);

test("explicit task retry waits for a late real result before recovering its input", async () => {
  const { f, original, thread, recovery, inbox, identity, first } = await startExplicitRetry();
  f.controls.invokeSourceTools = f.controls.singleSourceTool = f.controls.nativeSourceTools = true;
  f.controls.failAfterToolsKeepPage = true;
  f.controls.beforeToolsResultFailure = new ChatGptWebAdapterError("Message delivery timed out. Please try again.",
    { status: 503, errorType: "server_error", code: "chatgpt_delivery_timeout", retryable: true });
  const counter = join(f.statePath, "late-retry-count");
  f.controls.command = harmlessContinuityCommand(counter, "late explicit retry result");
  const explicit = f.request("Original instruction.", "turn-retry");
  const events = await f.run(explicit);
  const call = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start")!;
  expect(call).toBeDefined();
  const binding = continuityBindingsFor(f.statePath).observed(thread)!;
  expect(await chatGptTurnSessions.find(binding.executionKey!)!.browserOutcome).toMatchObject({ type: "error", error: { code: "chatgpt_delivery_timeout" } });
  f.controls.releaseDeferredCompletion?.(); await first;
  const input = [...(original._rawBody as { input: unknown[] }).input, currentRecordedCall(f.provider, explicit)];
  await expect(f.run(f.request("", "turn-retry", input))).rejects.toMatchObject({ code: "continuity_execution_unsettled" });
  const pending = recovery.get(thread)!.works[binding.recovery!.logicalWorkId]!;
  expect(pending.attempts).toHaveLength(1);
  expect(pending.attempts[0]!.writerRetired).toBe(false);
  expect(f.submissions).toHaveLength(2);
  expect(f.controls.actualAcquisitions).toBe(2);
  const executed = await $`${{ raw: f.controls.command }}`.quiet().nothrow();
  expect(executed.exitCode).toBe(0);
  f.controls.invokeSourceTools = false;
  expect((await f.run(f.request("", "turn-retry", [...input,
    { type: "function_call_output", call_id: call.id, output: executed.stdout.toString() }]))).at(-1))
    .toMatchObject({ type: "done", endTurn: true });
  expect(readFileSync(counter, "utf8")).toBe("x");
  expect(f.submissions).toHaveLength(3);
  expect(inbox.get(identity)!.state).toBe("completed");
}, 20_000);

test("explicit task retry cannot recover an unknown Send or complete its input", async () => {
  const { f, thread, recovery, inbox, identity, first } = await startExplicitRetry();
  const run = f.automatic.getMockImplementation()!;
  f.automatic.mockImplementation(turn => run({ ...turn, onSubmitted: async () => {
    throw new ChatGptWebAdapterError("Message delivery timed out. Please try again.",
      { status: 503, errorType: "server_error", code: "chatgpt_delivery_timeout", retryable: true });
  } }));
  expect((await f.run(f.request("Original instruction.", "turn-retry"))).at(-1)).toMatchObject({ type: "error", code: "chatgpt_delivery_timeout" });
  f.controls.releaseDeferredCompletion?.(); await first;
  for (const page of f.pages.values()) page.state = "ready";
  for (const tab of f.recoveryHost.turnTabs.values()) tab.status = "ready";
  expect((await f.run(f.request("Original instruction.", "turn-retry"))).at(-1)).toMatchObject({ type: "error", code: "chatgpt_delivery_timeout" });
  const record = recovery.get(thread)!, work = record.works[record.currentWorkId!]!;
  expect(work.attempts).toHaveLength(1);
  expect(work.attempts[0]!.sendEvidence?.status).toBe("possible");
  expect(work.attempts[0]!.writerRetired).toBe(false);
  expect(f.submissions).toHaveLength(2);
  expect(f.controls.actualAcquisitions).toBe(2);
  expect(inbox.get(identity)!.messages[0]!.status).toBe("accepted");
}, 20_000);

function storedTask() {
  const directory = mkdtempSync(join(tmpdir(), "cgw-explicit-retry-")); roots.push(directory);
  new ContinuityRegistrationStore(directory).initialize();
  const recovery = new ContinuityRecoveryStore(directory), inbox = new ContinuityTaskInputStore(directory);
  const thread = "1".repeat(64), scope = "2".repeat(64), owner = continuityProcessInstance();
  const identity = { thread, scope, taskId: `task_${taskUpdateDigest([thread, "turn-original"])}` };
  const admission = { thread, scope, owner, logicalWorkId: "original", instructionIdentity: "original-message", nativeTurnId: "turn-original",
    workPayloadDigest: "3".repeat(64), snapshotDigest: "4".repeat(64), createPage: true, dispatchProtocolComplete: true };
  recovery.admitWork(admission); inbox.receive(identity, [{ messageId: "original-message", text: "Original instruction." }]);
  return { directory, recovery, inbox, identity, admission };
}

test("explicit retry of the original instruction has a new lineage and cannot redeliver old settled calls", () => {
  const { directory, recovery, inbox, identity, admission } = storedTask(), guard = { scope: identity.scope };
  recovery.issueBatch(identity.thread, guard, { logicalWorkId: "original", attempt: 0,
    calls: [{ callId: "original-call", operationId: "original-operation", expectedResultType: "function_call_output" }] });
  recovery.markDeliveryPossible(identity.thread, guard, ["original-call"]);
  const result = { type: "function_call_output", call_id: "original-call", output: "Real command return." };
  recovery.acceptResult(identity.thread, guard, { callId: "original-call", resultType: result.type, resultDigest: recoveryResultDigest(result) });
  inbox.stop(identity); const stopped = recovery.stopWork(identity.thread, guard, "original", "user-stop");
  inbox.retry(identity, ["original-message"]);
  const retry = { taskId: identity.taskId, intentGeneration: inbox.get(identity)!.intentGeneration, sourceLogicalWorkId: "original",
    messageIds: ["original-message"], messageDigests: [taskUpdateDigest("Original instruction.")] };
  const ref = { directory, thread: identity.thread, logicalWorkId: "original", attempt: 0 };
  expect(() => recoveryContext(parseRequest({ model: "gpt-5.6-sol", input: [{ role: "user", content: "Original instruction." }] }), ref)).toThrow("real result body");
  const source = recoveryContext(parseRequest({ model: "gpt-5.6-sol", input: [{ role: "user", content: "Original instruction." }, result] }), ref);
  expect((source._rawBody as { input: unknown[] }).input.at(-1)).toEqual(result);
  const admitted = recovery.reserveTaskInputRetry({ ...admission, logicalWorkId: "explicit-retry" }, retry, recovery.get(identity.thread)!.version);
  const duplicate = new ContinuityRecoveryStore(directory).reserveTaskInputRetry({ ...admission, logicalWorkId: "explicit-retry" }, retry, stopped.version);
  expect(duplicate).toEqual(admitted);
  expect(admitted.epoch).toBe(stopped.epoch + 1);
  expect(admitted.works.original).toEqual(stopped.works.original);
  expect(admitted.calls["original-call"]).toMatchObject(stopped.calls["original-call"]!);
  expect(admitted.works["explicit-retry"]!.workLineageId).not.toBe(stopped.works.original!.workLineageId);
  expect(() => recovery.markDeliveryPossible(identity.thread, guard, ["original-call"])).toThrow();
  expect(() => recovery.issueBatch(identity.thread, guard, { logicalWorkId: "explicit-retry", attempt: 0,
    calls: [{ callId: "original-call", operationId: "original-operation", expectedResultType: "function_call_output" }] })).toThrow();
});

test("an explicit retry cannot turn an unknown Send into a fresh execution", () => {
  const { recovery, inbox, identity, admission } = storedTask(), guard = { scope: identity.scope };
  recovery.markAttempt(identity.thread, guard, { logicalWorkId: "original", attempt: 0, stage: "send-possible" });
  inbox.stop(identity); const stopped = recovery.stopWork(identity.thread, guard, "original", "user-stop"); inbox.retry(identity, ["original-message"]);
  const retry = { taskId: identity.taskId, intentGeneration: inbox.get(identity)!.intentGeneration, sourceLogicalWorkId: "original",
    messageIds: ["original-message"], messageDigests: [taskUpdateDigest("Original instruction.")] };
  expect(() => recovery.reserveTaskInputRetry({ ...admission, logicalWorkId: "explicit-retry" }, retry, stopped.version)).toThrow("previous Send remains unverified");
  expect(recovery.get(identity.thread)).toEqual(stopped);
});

test("the real Send reservation rechecks the captured inbox intent under the same lock", () => {
  const { directory, recovery, inbox, identity } = storedTask();
  const original = recovery.get(identity.thread)!, send = recoveryIdentity(original, recovery.installationId());
  inbox.stop(identity); inbox.retry(identity, ["original-message"]);
  expect(() => beginRecoverySend({ directory, thread: identity.thread, logicalWorkId: "original", attempt: 0 }, send, undefined,
    () => inbox.assertExecutionIntent(identity, 0))).toThrow();
  expect(recovery.get(identity.thread)).toEqual(original);
});
