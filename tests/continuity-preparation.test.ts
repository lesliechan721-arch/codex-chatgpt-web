import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ContextSend } from "../src/adapters/chatgpt-web/context-send";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { ContinuityRecoveryStore } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import type { ContinuityLease } from "../src/adapters/chatgpt-web/continuity-contract";
import { createSessionContinuityFixtures } from "./helpers/session-continuity-fixture";

const { fixture, disposeTestFixtures } = createSessionContinuityFixtures(import.meta.path);
afterEach(disposeTestFixtures);

for (const manual of [false, true]) for (const failureKind of ["compile", "read", "plan"]) {
  test(`${manual ? "Zero Risk" : "Automatic"} local ${failureKind} failure keeps history and permits a fresh same-page attempt`, async () => {
    const f = fixture(manual);
    f.descriptor.features.push("preparation-termination-v1");
    writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor), { mode: 0o600 });
    const first = f.request();
    await f.run(first);
    const request = f.next(first);
    const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
    const sourceExecutionKey = binding.executionKey;
    const checkpointKeys = [...binding.checkpoints.keys()];
    const historyRevision = binding.revision;
    const original = new ChatGptWebAdapterError(`Controlled local ${failureKind} failure`, {
      status: 422, errorType: "invalid_request_error", code: `preparation_${failureKind}_fixture`, retryable: false,
    });
    const normalRun = f.automatic.getMockImplementation()!;
    let prepare: ReturnType<typeof spyOn> | undefined;
    if (manual) prepare = spyOn(ContextSend.prototype, "prepare").mockRejectedValue(original);
    else f.automatic.mockImplementation(async turn => {
      const lease = { ...turn.continuity!.expected!, traceId: turn.traceId, recovery: turn.continuity!.recovery! };
      f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
      turn.onContinuityLease!(lease);
      new ContinuityRecoveryStore(f.statePath).terminatePreparation(turn.continuity!.recovery!, {
        requestId: turn.recoveryRequestId!, traceId: turn.traceId, helperPid: process.pid, lease,
      });
      throw original;
    });
    const failed = await f.run(request);
    prepare?.mockRestore(); f.automatic.mockImplementation(normalRun);
    expect(failed.at(-1)).toMatchObject({ type: "error", code: original.code, message: original.message });
    expect(f.submissions).toHaveLength(1); expect(f.pages.size).toBe(1);
    expect([...f.pages.values()][0]!.state).toBe("ready");
    expect(binding.state).toBe("ready"); expect(binding.executionKey).toBe(sourceExecutionKey);
    expect(binding.revision).toBe(historyRevision); expect([...binding.checkpoints.keys()]).toEqual(checkpointKeys);
    const record = new ContinuityRecoveryStore(f.statePath).get(binding.thread)!;
    const failedWorkId = record.currentWorkId!;
    expect(record.works[failedWorkId]!.attempts.at(-1)!.preparationTermination?.status).toBe("settled");
    const leaseId = binding.lease!.leaseId;
    expect((await f.run(request)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(f.submissions).toHaveLength(2); expect(f.submissions.at(-1)!.reused).toBe(true);
    expect(binding.lease!.leaseId).toBe(leaseId);
    const retried = new ContinuityRecoveryStore(f.statePath).get(binding.thread)!;
    expect(retried.works[failedWorkId]!.attempts).toHaveLength(2);
    expect(retried.works[failedWorkId]!.attempts[0]!.writerRetired).toBe(true);
  });
}

test("a missing termination reply preserves the original failure and the same receipt is recovered on retry", async () => {
  const f = fixture();
  f.descriptor.features.push("preparation-termination-v1");
  writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor), { mode: 0o600 });
  const first = f.request(); await f.run(first);
  const next = f.next(first);
  const normalRun = f.automatic.getMockImplementation()!;
  f.controls.terminationConfirmFailures = 1;
  f.automatic.mockImplementation(async turn => {
    const lease = { ...turn.continuity!.expected!, traceId: turn.traceId, recovery: turn.continuity!.recovery! };
    f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    new ContinuityRecoveryStore(f.statePath).terminatePreparation(turn.continuity!.recovery!, {
      requestId: turn.recoveryRequestId!, traceId: turn.traceId, helperPid: process.pid, lease,
    });
    throw new ChatGptWebAdapterError("Original local read failure", { status: 422, errorType: "invalid_request_error", code: "preparation_read_fixture", retryable: true });
  });
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "error", code: "preparation_read_fixture", message: "Original local read failure" });
  const store = new ContinuityRecoveryStore(f.statePath), before = store.get(continuityDigest(f.threadId))!;
  const workId = before.currentWorkId!, receiptId = before.works[workId]!.attempts[0]!.preparationTermination!.receiptId;
  expect(before.works[workId]!.attempts[0]!.preparationTermination!.status).toBe("pending");
  expect(f.submissions).toHaveLength(1);
  f.automatic.mockImplementation(normalRun);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const recovered = store.get(before.thread)!;
  expect(recovered.works[workId]!.attempts[0]!.preparationTermination).toMatchObject({ status: "settled", receiptId });
  expect(f.submissions).toHaveLength(2);
});

test("a healthy possibly sent failure keeps its original error and cannot trigger another Send", async () => {
  const f = fixture();
  f.descriptor.features.push("preparation-termination-v1");
  writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor), { mode: 0o600 });
  const first = f.request(); await f.run(first);
  const request = f.next(first), original = new ChatGptWebAdapterError("Send acknowledgement is unresolved", {
    code: "chatgpt_submission_ambiguous", status: 502, errorType: "server_error", retryable: true,
  });
  let activated = 0;
  f.automatic.mockImplementation(async turn => {
    const lease = { ...turn.continuity!.expected!, traceId: turn.traceId, recovery: turn.continuity!.recovery! };
    f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    await turn.prepareResume!();
    activated++; await turn.onSendActivated!();
    throw original;
  });
  expect((await f.run(request)).at(-1)).toMatchObject({ type: "error", code: original.code, message: original.message, retryable: true });
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.state).toBe("unverified"); expect(f.pages.size).toBe(1);
  expect([...f.pages.values()][0]!.state).toBe("running");
  const record = new ContinuityRecoveryStore(f.statePath).get(binding.thread)!;
  const attempt = record.works[record.currentWorkId!]!.attempts.at(-1)!;
  expect(attempt.sendEvidence?.status).toBe("possible"); expect(attempt.preparationTermination).toBeUndefined();
  expect((await f.run(request)).at(-1)).toMatchObject({ type: "error", code: original.code });
  expect(activated).toBe(1); expect(f.submissions).toHaveLength(1);
});

test("Zero Risk plan selection after prompt publication preserves its possible Send and healthy lease", async () => {
  const f = fixture(true);
  f.descriptor.features.push("preparation-termination-v1");
  writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor), { mode: 0o600 });
  const first = f.request(); await f.run(first);
  const request = f.next(first), original = new ChatGptWebAdapterError("Controlled local plan selection failure", {
    code: "CONTEXT_SOURCE_UNAVAILABLE", status: 422, errorType: "invalid_request_error", retryable: false,
  });
  const select = spyOn(ContextSend.prototype, "select").mockRejectedValue(original);
  let failed;
  try { failed = await f.run(request); } finally { select.mockRestore(); }
  expect(failed.at(-1)).toMatchObject({ type: "error", code: original.code, message: original.message });
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.state).toBe("unverified"); expect(f.pages.size).toBe(1);
  expect([...f.pages.values()][0]!.continuity).toEqual(binding.lease!);
  const record = new ContinuityRecoveryStore(f.statePath).get(binding.thread)!;
  const attempt = record.works[record.currentWorkId!]!.attempts.at(-1)!;
  expect(attempt.sendEvidence?.status).toBe("possible"); expect(attempt.preparationTermination).toBeUndefined();
  expect(f.submissions).toHaveLength(2);
  expect((await f.run(request)).at(-1)).toMatchObject({ type: "error", code: original.code });
  expect(f.submissions).toHaveLength(2);
});

test("an obsolete preparation failure cannot overwrite a committed successor", async () => {
  const f = fixture();
  f.descriptor.features.push("preparation-termination-v1");
  writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor), { mode: 0o600 });
  const first = f.request(); await f.run(first);
  const request = f.next(first), store = new ContinuityRecoveryStore(f.statePath);
  let successor: ReturnType<typeof store.get>, successorLease: ContinuityLease | undefined;
  const original = new ChatGptWebAdapterError("Obsolete local preparation error", {
    code: "CONTEXT_SOURCE_UNAVAILABLE", status: 422, errorType: "invalid_request_error", retryable: false,
  });
  f.automatic.mockImplementation(async turn => {
    const lease = { ...turn.continuity!.expected!, traceId: turn.traceId, recovery: turn.continuity!.recovery! };
    f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    const termination = store.terminatePreparation(turn.continuity!.recovery!, {
      requestId: turn.recoveryRequestId!, traceId: turn.traceId, helperPid: process.pid, lease,
    })!;
    const prior = store.settlePreparationTermination(termination.recovery, termination.receiptId)!;
    store.admitWork({ thread: prior.thread, scope: prior.scope, owner: prior.owner,
      logicalWorkId: "committed-successor", instructionIdentity: "successor-instruction", nativeTurnId: "successor-turn",
      workPayloadDigest: "a".repeat(64), snapshotDigest: "b".repeat(64), createPage: false, dispatchProtocolComplete: true });
    successor = store.completeWork(prior.thread, { scope: prior.scope }, "committed-successor", { receiptId: "successor-final", digest: "c".repeat(64) });
    const binding = continuityBindingsFor(f.statePath).observed(prior.thread)!;
    binding.executionKey = "committed-successor-execution"; binding.state = "ready";
    f.pages.get(turn.conversationKey!)!.state = "ready";
    successorLease = structuredClone(binding.lease);
    throw original;
  });
  expect((await f.run(request)).at(-1)).toMatchObject({ type: "error", code: original.code, message: original.message });
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(store.get(binding.thread)).toEqual(successor);
  expect(binding.executionKey).toBe("committed-successor-execution"); expect(binding.state).toBe("ready");
  expect(binding.lease).toEqual(successorLease); expect(f.pages.size).toBe(1); expect(f.submissions).toHaveLength(1);
});
