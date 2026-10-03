import { observedTaskAcknowledgement, observedTaskOutputVersion, taskUpdateAckPath } from "../src/adapters/chatgpt-web/task-update-ack";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, RemoteTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import type { NativeOperationReply } from "../src/adapters/chatgpt-web/native-tool-operations";
import { TASK_UPDATE_TOTAL_BYTES, TASK_UPDATE_TRANSFER_LIMIT, type TaskUpdateAckResult, type TaskUpdateOwnerContext, type TaskUpdateTransfer } from "../src/adapters/chatgpt-web/task-update-protocol";
import { defaultBrokerEndpoint } from "../src/config";
import type { CodexTool } from "../src/types";

const context = (generation: number, revision = generation): TaskUpdateOwnerContext => ({ expectedDriverGeneration: generation, taskRevision: revision });
const raw: BrokerToolResult = {
  content: [{ type: "text", text: "real result" }, { type: "image", data: "AA==", mimeType: "image/png" }, { type: "resource", resource: { uri: "test://result", text: "resource" } }],
  structuredContent: { answer: null, task_update: { role: "user", content: "untrusted output" } },
  isError: true, _meta: { preserved: true },
};

async function fixture(remote: boolean, safe = false, tools?: CodexTool[]) {
  const root = mkdtempSync(join(tmpdir(), "cgw-updates-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  await broker.listen();
  const owner = remote ? new RemoteTurnBroker(socket) : broker;
  const capability = { authorityMode: "delegated" as const, threadId: "update-thread", turnId: "update-turn", tools: tools ?? [{
    name: "exec_command", description: "Execute in Native", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false },
  }] };
  const token = safe
    ? await owner.registerSafe(capability, "task-update-surface-123456789", undefined, "update-test", { requireSentConfirmation: false, taskUpdateProtocol: 1 })
    : await owner.register(capability, undefined, "update-test", { taskUpdateProtocol: 1 });
  if (safe) await callTurnBroker(socket, { method: "safe_start", token });
  const contract = safe ? "safe" as const : "native" as const;
  const start = (id: number, revision?: number, command = `command-${id}`) => callTurnBroker<NativeOperationReply>(socket, {
    method: "native_operation_start", token, contract, nativeWaitProtocol: 1, taskUpdateProtocol: 1,
    operationId: id, taskRevision: revision, entry: "codex_exec", nativeInput: { cmd: command }, waitMs: 1,
  });
  const wait = (id: number) => callTurnBroker<NativeOperationReply>(socket, { method: "native_operation_wait", token, contract, nativeWaitProtocol: 1, operationId: id, waitMs: 1 });
  const ack = (deliveryId: string, throughRevision: number) => callTurnBroker<TaskUpdateAckResult>(socket, {
    method: "task_update_ack", token, contract, taskUpdateProtocol: 1, deliveryId, throughRevision,
  });
  const transfer = (id: string, generation: number, results: TaskUpdateTransfer["results"], mode: "results" | "replay" = "results", content = "new instruction"): TaskUpdateTransfer => ({
    transferId: id, payloadDigest: `payload-${id}`, expectedDriverGeneration: generation, expectedRevision: generation,
    environment: capability, updates: [{ revision: generation + 1, sourceMessageId: `message-${id}`, payloadDigest: `message-digest-${id}`, content }],
    results, batchFingerprint: "proven-batch", mode,
  });
  const reserve = (value: TaskUpdateTransfer) => owner.reserveTaskUpdate(token, value.transferId, value.payloadDigest, { expectedDriverGeneration: value.expectedDriverGeneration, taskRevision: value.expectedRevision });
  const accept = async (value: TaskUpdateTransfer) => { await reserve(value); return owner.acceptTaskUpdate(token, value); };
  return { root, socket, broker, owner, capability, token, start, wait, ack, transfer, reserve, accept,
    async close() { await owner.revokeTrusted(token); await broker.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const remote of [false, true]) describe(`${remote ? "Remote" : "Local"} task update state`, () => {
  test("a captured pre-ACK candidate remains rejected after ACK without locking the output window", async () => {
    const f = await fixture(remote);
    try {
      await f.start(1, 0);
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      await f.accept(f.transfer("pre-ack", 0, [{ callId: call!.callId, result: raw }]));
      const reply = await f.wait(1);
      const candidate = { ...context(1), acknowledgedRevision: 0 };
      await f.ack(reply.taskUpdate!.deliveryId, 1);
      await expect(Promise.resolve().then(() => f.owner.checkFinalOutputCandidate(f.token, candidate)))
        .rejects.toMatchObject({ code: "task_update_unacknowledged" });
      await expect(Promise.resolve().then(() => f.owner.beginCompletionFence(f.token, candidate)))
        .rejects.toMatchObject({ code: "task_update_unacknowledged" });
      await expect(Promise.resolve().then(() => f.owner.beginFinalOutput(f.token, candidate)))
        .rejects.toMatchObject({ code: "task_update_unacknowledged" });
      await f.owner.checkFinalOutputCandidate(f.token, { ...context(1), acknowledgedRevision: 1 });
      expect((await f.owner.taskUpdateState(f.token))?.finalOutputRevision).toBeNull();
    } finally { await f.close(); }
  });

  test("ACK publications qualify stale mirrors without upgrading an earlier captured decision", async () => {
    const f = await fixture(remote);
    let directory: string | undefined;
    try {
      await f.start(1, 0);
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      await f.accept(f.transfer("ack-publication", 0, [{ callId: call!.callId, result: raw }]));
      const reply = await f.wait(1);
      const staleMirror = (await f.owner.taskUpdateState(f.token))!;
      directory = staleMirror.acknowledgementDirectory!;
      expect(existsSync(directory)).toBeTrue();
      const capturedBeforeAck = { ...context(1), acknowledgedRevision: observedTaskAcknowledgement(staleMirror) };
      expect(capturedBeforeAck.acknowledgedRevision).toBe(0);
      await f.ack(reply.taskUpdate!.deliveryId, 1);
      expect(staleMirror.acknowledgedRevision).toBe(0);
      expect(observedTaskAcknowledgement(staleMirror)).toBe(1);
      await expect(Promise.resolve().then(() => f.owner.checkFinalOutputCandidate(f.token, capturedBeforeAck)))
        .rejects.toMatchObject({ code: "task_update_unacknowledged" });
      await f.owner.checkFinalOutputCandidate(f.token, { ...context(1), acknowledgedRevision: observedTaskAcknowledgement(staleMirror) });
      expect((await f.owner.taskUpdateState(f.token))!.finalOutputRevision).toBeNull();
      await f.owner.revokeTrusted(f.token);
      expect(existsSync(directory)).toBeTrue(); // Retained only with the bounded recovery receipts.
    } finally { await f.close(); }
    expect(existsSync(directory!)).toBeFalse();
  });

  test("ACK publication failure cannot return a successful ACK or advance its head", async () => {
    const f = await fixture(remote);
    try {
      await f.start(1, 0);
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      await f.accept(f.transfer("ack-storage-failure", 0, [{ callId: call!.callId, result: raw }]));
      const reply = await f.wait(1);
      const staleMirror = (await f.owner.taskUpdateState(f.token))!;
      mkdirSync(taskUpdateAckPath(staleMirror.acknowledgementDirectory!, 1));
      await expect(f.ack(reply.taskUpdate!.deliveryId, 1)).rejects.toBeDefined();
      expect((await f.owner.taskUpdateState(f.token))!.acknowledgedRevision).toBe(0);
      expect(() => observedTaskAcknowledgement(staleMirror)).toThrow("Invalid task update acknowledgment publication");
    } finally { await f.close(); }
  });

  test("version publication failure preserves the old head and cannot release real results", async () => {
    const f = await fixture(remote);
    try {
      await f.start(1, 0);
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      const state = (await f.owner.taskUpdateState(f.token))!;
      const pending = join(state.acknowledgementDirectory!, "version.next");
      mkdirSync(pending);
      const failed = f.transfer("version-storage-failure", 0, [{ callId: call!.callId, result: raw }]);
      expect(await f.accept(failed)).toMatchObject({ status: "not_committed" });
      expect(await f.owner.taskUpdateState(f.token)).toMatchObject({ acceptedRevision: 0, driverGeneration: 0 });
      expect(observedTaskOutputVersion(state)).toEqual({ acceptedRevision: 0, driverGeneration: 0 });
      expect(await f.wait(1)).toMatchObject({ kind: "pending" });
      rmSync(pending, { recursive: true });
      const retry = f.transfer("version-storage-recovered", 0, [{ callId: call!.callId, result: raw }]);
      expect(await f.accept(retry)).toMatchObject({ status: "committed" });
      expect(observedTaskOutputVersion(state)).toEqual({ acceptedRevision: 1, driverGeneration: 1 });
      expect(await f.owner.acceptTaskUpdate(f.token, failed)).toMatchObject({ status: "not_committed" });
      expect(await f.wait(1)).toMatchObject({ kind: "result", result: raw });
    } finally { await f.close(); }
  });

  test("an atomic real-result transfer preserves operation identity and result data", async () => {
    const f = await fixture(remote);
    try {
      expect(await f.start(1, 0)).toMatchObject({ kind: "pending" });
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      const value = f.transfer("first", 0, [{ callId: call!.callId, result: raw }]);
      const committed = await f.accept(value);
      expect(committed).toMatchObject({ status: "committed", state: { acceptedRevision: 1, driverGeneration: 1, acknowledgedRevision: 0 } });
      expect(await f.owner.acceptTaskUpdate(f.token, value)).toEqual(committed);
      await expect(Promise.resolve().then(() => f.owner.acceptTaskUpdate(f.token, { ...value, updates: [{ ...value.updates[0]!, content: "changed" }] }))).rejects.toMatchObject({ code: "task_update_transfer_conflict" });
      const reply = await f.wait(1);
      expect(reply).toMatchObject({ kind: "result", result: raw, taskUpdate: { fromRevision: 1, throughRevision: 1, updates: [{ content: "new instruction" }] } });
      expect(reply.taskUpdate!.updates).toHaveLength(1);
      expect(await f.start(1, 0)).toEqual(reply);
      await expect(f.start(1, 1)).rejects.toMatchObject({ code: "codex_tool_operation_conflict" });
      await f.ack(reply.taskUpdate!.deliveryId, 1);
      expect(await f.wait(1)).toEqual({ kind: "result", result: raw });
      const refused = await f.start(2, 0);
      expect(refused).toMatchObject({ kind: "result", result: { structuredContent: { code: "task_update_not_executed" }, _meta: { "codex/native-control": { kind: "task-update" } } } });
      expect(await f.start(2, 0)).toEqual(refused);
      await expect(f.start(2, 1)).rejects.toMatchObject({ code: "codex_tool_operation_conflict" });
      expect(await f.start(3, 1)).toMatchObject({ kind: "pending" });
      const batch = await f.owner.nextToolBatch(f.token, undefined, context(1));
      expect(batch).toHaveLength(1);
      await f.owner.completeTool(f.token, batch[0]!.callId, raw, context(1));
      expect(await f.wait(3)).toEqual({ kind: "result", result: raw });
    } finally { await f.close(); }
  });

  test("immutable delivery ACK chains retain every update and do not upgrade old ACKs", async () => {
    const f = await fixture(remote);
    try {
      await f.start(1, 0);
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      const results = [{ callId: call!.callId, result: raw }];
      await f.accept(f.transfer("r1", 0, results));
      const first = (await f.wait(1)).taskUpdate!;
      await f.accept(f.transfer("r2", 1, results, "replay", "same text"));
      await f.accept(f.transfer("r3", 2, results, "replay", "same text"));
      expect((await f.wait(1)).taskUpdate).toEqual(first);
      await expect(f.ack("unknown", 3)).rejects.toMatchObject({ code: "task_update_delivery_invalid" });
      await expect(f.ack(first.deliveryId, 3)).rejects.toMatchObject({ code: "task_update_delivery_invalid" });
      const ack1 = await f.ack(first.deliveryId, 1);
      expect(ack1).toMatchObject({ acknowledgedRevision: 1, acceptedRevision: 3, taskUpdate: { fromRevision: 2, throughRevision: 3 } });
      expect(ack1.taskUpdate!.updates.map(update => update.sourceMessageId)).toEqual(["message-r2", "message-r3"]);
      expect(await f.ack(first.deliveryId, 1)).toEqual(ack1);
      await f.ack(ack1.taskUpdate!.deliveryId, 3);
      expect(await f.ack(first.deliveryId, 1)).toEqual({ acknowledgedRevision: 3, acceptedRevision: 3 });
      const closed = await f.accept(f.transfer("closed", 3, results, "replay"));
      expect(closed).toMatchObject({ status: "not_committed", code: "task_update_no_boundary" });
      expect((await f.owner.taskUpdateState(f.token))!.driverGeneration).toBe(3);
    } finally { await f.close(); }
  });

  test("instruction revisions and driver generations remain distinct and observation adds no Native work", async () => {
    const f = await fixture(remote);
    try {
      await f.start(1, 0);
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      const before = await f.broker.waitForNativeWaiting(f.token, 0);
      const observing = f.owner.waitForTaskUpdateState(f.token, 0);
      const value = f.transfer("several", 0, [{ callId: call!.callId, result: raw }]);
      value.updates.push({ revision: 2, sourceMessageId: "second-message", payloadDigest: "second-digest", content: "another addition" });
      await f.accept(value);
      expect(await observing).toMatchObject({ state: { acceptedRevision: 2, driverGeneration: 1 } });
      const delivery = (await f.wait(1)).taskUpdate!;
      expect(delivery.updates.map(update => update.revision)).toEqual([1, 2]);
      const nativeBeforeAck = await f.broker.waitForNativeWaiting(f.token, before.revision);
      const serialBefore = await f.owner.waitForTaskUpdateState(f.token, 0);
      const ackObservation = f.owner.waitForTaskUpdateState(f.token, serialBefore.revision);
      await f.ack(delivery.deliveryId, 2);
      expect(await ackObservation).toMatchObject({ state: { acknowledgedRevision: 2, driverGeneration: 1 } });
      const noNativeChange = new AbortController();
      const nativeObservation = f.owner.waitForNativeWaiting(f.token, nativeBeforeAck.revision, noNativeChange.signal).catch(error => error);
      noNativeChange.abort();
      expect(await nativeObservation).toMatchObject({ name: "AbortError" });
      expect(await f.owner.beginFinalOutput(f.token, context(1, 2))).toMatchObject({ taskRevision: 2, driverGeneration: 1 });
    } finally { await f.close(); }
  });

  test("ACK reply encoding owns an activity lease and a late request cannot resurrect cleanup", async () => {
    const f = await fixture(remote);
    try {
      await f.start(1, 0);
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      await f.accept(f.transfer("control-activity", 0, [{ callId: call!.callId, result: raw }]));
      const delivery = (await f.wait(1)).taskUpdate!;
      const activityId = "activity_task_update_reply_123456789";
      const ackRequest = { method: "task_update_ack" as const, token: f.token, contract: "native" as const,
        taskUpdateProtocol: 1, deliveryId: delivery.deliveryId, throughRevision: 1, activityId };
      await callTurnBroker(f.socket, ackRequest);
      expect(await f.owner.beginCompletionFence(f.token, context(1))).toBeUndefined();
      await expect(Promise.resolve().then(() => f.owner.beginFinalOutput(f.token, context(1)))).rejects.toMatchObject({ code: "task_update_tools_pending" });
      await callTurnBroker(f.socket, { method: "activity_complete", token: f.token, activityId });
      const fence = await f.owner.beginCompletionFence(f.token, context(1));
      await expect(callTurnBroker(f.socket, ackRequest)).rejects.toMatchObject({ code: "task_update_activity_completed" });
      expect(await f.owner.commitCompletionFence(f.token, fence!, context(1))).toBe(false);
      expect(await f.owner.beginCompletionFence(f.token, context(1))).toBeNumber();
    } finally { await f.close(); }
  });

  test("full batch rejection is immutable and never completes only some real results", async () => {
    const f = await fixture(remote);
    try {
      await Promise.all([f.start(1, 0), f.start(2, 0)]);
      const batch = await f.owner.nextToolBatch(f.token, undefined, context(0));
      expect(batch).toHaveLength(2);
      const incomplete = f.transfer("partial", 0, [{ callId: batch[0]!.callId, result: raw }]);
      const refused = await f.accept(incomplete);
      expect(refused).toMatchObject({ status: "not_committed", code: "task_update_batch_invalid" });
      expect(await f.owner.acceptTaskUpdate(f.token, incomplete)).toEqual(refused);
      const duplicate = f.transfer("duplicate", 0, [incomplete.results[0]!, incomplete.results[0]!]);
      expect(await f.accept(duplicate)).toMatchObject({ status: "not_committed", code: "task_update_batch_invalid" });
      const unknown = f.transfer("unknown", 0, [{ callId: batch[0]!.callId, result: raw }, { callId: "foreign-call", result: raw }]);
      expect(await f.accept(unknown)).toMatchObject({ status: "not_committed", code: "task_update_batch_invalid" });
      expect(await f.wait(1)).toMatchObject({ kind: "pending" });
      expect(await f.wait(2)).toMatchObject({ kind: "pending" });
      expect(await f.owner.taskUpdateState(f.token)).toMatchObject({ acceptedRevision: 0, driverGeneration: 0 });
      const valid = f.transfer("valid", 0, batch.map(call => ({ callId: call.callId, result: raw })));
      expect(await f.accept(valid)).toMatchObject({ status: "committed" });
      expect(await f.wait(1)).toMatchObject({ kind: "result", result: raw });
      expect(await f.wait(2)).toMatchObject({ kind: "result", result: raw });
    } finally { await f.close(); }
  });

  test("queued calls remain not-executed after ACK while handed-off calls keep their result", async () => {
    const f = await fixture(remote);
    try {
      await f.start(1, 0);
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      await f.start(2, 0);
      await f.accept(f.transfer("queued", 0, [{ callId: call!.callId, result: raw }]));
      const real = await f.wait(1);
      const rejected = await f.wait(2);
      expect(real).toMatchObject({ kind: "result", result: raw });
      expect(rejected).toMatchObject({ kind: "result", result: { structuredContent: { code: "task_update_not_executed" } } });
      const beforeAck = await f.start(3, 1);
      expect(beforeAck).toMatchObject({ kind: "result", result: { structuredContent: { code: "task_update_not_executed" } } });
      await f.ack(real.taskUpdate!.deliveryId, 1);
      expect(await f.wait(2)).toMatchObject({ kind: "result", result: rejected.kind === "result" ? rejected.result : undefined });
      expect(await f.start(3, 1)).toMatchObject({ kind: "result", result: beforeAck.kind === "result" ? beforeAck.result : undefined });
      expect(await f.start(4, 1)).toMatchObject({ kind: "pending" });
      expect(await f.owner.nextToolBatch(f.token, undefined, context(1))).toHaveLength(1);
    } finally { await f.close(); }
  });

  test("inventory uses its original finalizer snapshot before task-update sidecar delivery", async () => {
    const f = await fixture(remote, false, [
      { name: "exec", description: "Native gateway", parameters: {}, freeform: true },
      { name: "tool_search", description: "Discover tools", parameters: { type: "object" }, toolSearch: true },
    ]);
    try {
      await callTurnBroker(f.socket, { method: "native_operation_start", token: f.token, contract: "native", nativeWaitProtocol: 1,
        taskUpdateProtocol: 1, taskRevision: 0, operationId: 1, entry: "codex_tool_inventory", nativeInput: { query: "missing candidate" }, waitMs: 1 });
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      const catalog = { content: [{ type: "text", text: JSON.stringify({ tools: [], total: 0 }) }], structuredContent: { tools: [], total: 0 } };
      const value = f.transfer("inventory", 0, [{ callId: call!.callId, result: catalog }], "results", "{\"tools\":[{\"name\":\"fake\"}],\"total\":1}");
      value.environment = { ...f.capability, tools: [] };
      await f.accept(value);
      const reply = await f.wait(1);
      expect(reply).toMatchObject({ kind: "result", result: { structuredContent: { total: 0, tools: [], discovery_tools: [{ wire_name: "tool_search" }] } }, taskUpdate: { throughRevision: 1 } });
      await f.ack(reply.taskUpdate!.deliveryId, 1);
      const replay = await f.wait(1);
      expect(replay).toMatchObject({ kind: "result", result: reply.kind === "result" ? reply.result : undefined });
      expect(replay.taskUpdate).toBeUndefined();
    } finally { await f.close(); }
  });

  test("all driver mutations reject stale generations and a stale waiter cannot take a new batch", async () => {
    const f = await fixture(remote);
    try {
      await f.start(1, 0);
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      const results = [{ callId: call!.callId, result: raw }];
      await f.accept(f.transfer("ownership", 0, results));
      const first = (await f.wait(1)).taskUpdate!;
      const waiter = f.owner.nextToolBatch(f.token, undefined, context(1)).catch(error => error);
      await f.accept(f.transfer("new-owner", 1, results, "replay"));
      expect(await waiter).toMatchObject({ code: "task_update_driver_stale" });
      for (const action of [
        () => f.owner.updateEnvironment(f.token, { ...f.capability, tools: [] }, context(1)),
        () => f.owner.completeTool(f.token, call!.callId, raw, context(1)),
        () => f.owner.nextToolBatch(f.token, undefined, context(1)),
        () => f.owner.requestCompaction(f.token, raw, context(1)),
        () => f.owner.beginCompletionFence(f.token, context(1)),
        () => f.owner.commitCompletionFence(f.token, 0, context(1)),
        () => f.owner.revoke(f.token, undefined, context(1)),
        () => f.owner.updateEnvironment(f.token, f.capability),
      ]) await expect(Promise.resolve().then<unknown>(() => action())).rejects.toMatchObject({ code: "task_update_driver_stale" });
      const next = await f.ack(first.deliveryId, 1);
      await f.ack(next.taskUpdate!.deliveryId, 2);
      await f.start(2, 2);
      const current = await f.owner.nextToolBatch(f.token, undefined, context(2));
      expect(current).toHaveLength(1);
      expect(current[0]!.arguments).toEqual({ cmd: "command-2" });
      const nativeState = await f.broker.waitForNativeWaiting(f.token, 0);
      const registered = f.owner.waitForNativeWaiting(f.token, nativeState.revision);
      const pendingQuery = callTurnBroker(f.socket, { method: "native_operation_wait", token: f.token, contract: "native", nativeWaitProtocol: 1, operationId: 2, waitMs: 30_000 }).catch(error => error);
      await registered;
      await f.owner.revokeTrusted(f.token, new DOMException("host interrupt", "AbortError"));
      const cancelled = await pendingQuery;
      expect(cancelled).toMatchObject({ code: "codex_tool_cancelled", message: "The Native turn was explicitly cancelled" });
      await expect(f.wait(2)).rejects.toMatchObject({ code: "codex_tool_operation_retired" });
    } finally { await f.close(); }
  });

  test("invalid task revisions consume no ID and protocol is fixed at creation", async () => {
    const f = await fixture(remote);
    try {
      for (const revision of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(f.start(1, revision)).rejects.toMatchObject({ code: "task_update_revision_required" });
      }
      expect(await f.start(1, 0)).toMatchObject({ kind: "pending" });
      expect(await f.owner.nextToolBatch(f.token, undefined, context(0))).toHaveLength(1);
      const old = await f.owner.register(f.capability);
      expect(await f.owner.taskUpdateState(old)).toBeUndefined();
      await expect(Promise.resolve().then(() => f.owner.reserveTaskUpdate(old, "bad", "bad", context(0)))).rejects.toMatchObject({ code: "task_update_upgrade_required" });
      await f.owner.updateEnvironment(old, f.capability);
      await f.owner.revoke(old);
    } finally { await f.close(); }
  });

  test("completion can lock before text and rejects captured candidates from an older task", async () => {
    const f = await fixture(remote);
    try {
      const oldFence = await f.owner.beginCompletionFence(f.token, context(0));
      await f.start(1, 0);
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      await f.accept(f.transfer("completion", 0, [{ callId: call!.callId, result: raw }]));
      const first = (await f.wait(1)).taskUpdate!;
      await expect(Promise.resolve().then(() => f.owner.beginCompletionFence(f.token, context(1)))).rejects.toMatchObject({ code: "task_update_unacknowledged" });
      await f.ack(first.deliveryId, 1);
      await expect(Promise.resolve().then(() => f.owner.commitCompletionFence(f.token, oldFence!, context(0)))).rejects.toMatchObject({ code: "task_update_driver_stale" });
      expect(await f.owner.commitCompletionFence(f.token, oldFence!, context(1))).toBe(false);
      const fence = await f.owner.beginCompletionFence(f.token, context(1));
      expect(await f.owner.commitCompletionFence(f.token, fence!, context(1))).toBe(true);
      const receipt = await f.owner.taskOutputReceipt(f.token);
      expect(receipt).toEqual({ kind: "completed", taskRevision: 1, driverGeneration: 1, fenceRevision: fence });
      expect(await f.owner.beginFinalOutput(f.token, context(1))).toEqual(receipt!);
      expect(await f.owner.commitCompletionFence(f.token, fence!, context(1))).toBe(true);
      await f.owner.revokeTrusted(f.token);
      expect(await f.owner.taskOutputReceipt(f.token)).toEqual(receipt);
    } finally { await f.close(); }
  });

  test("final output ignores later ACK and closes new starts and transfer reservations", async () => {
    const f = await fixture(remote);
    try {
      await f.start(1, 0);
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      await f.accept(f.transfer("final", 0, [{ callId: call!.callId, result: raw }]));
      const first = (await f.wait(1)).taskUpdate!;
      await f.ack(first.deliveryId, 1);
      const receipt = await f.owner.beginFinalOutput(f.token, context(1));
      expect(receipt).toEqual({ kind: "output_started", taskRevision: 1, driverGeneration: 1 });
      expect(await f.ack(first.deliveryId, 1)).toEqual({ acknowledgedRevision: 1, acceptedRevision: 1, ignored: "final_output_started" });
      expect(await f.ack("no-longer-relevant", 999)).toEqual({ acknowledgedRevision: 1, acceptedRevision: 1, ignored: "final_output_started" });
      expect(await f.start(2, 1)).toMatchObject({ kind: "result", result: { structuredContent: { code: "task_update_not_executed" } } });
      await expect(Promise.resolve().then(() => f.reserve(f.transfer("too-late", 1, [{ callId: call!.callId, result: raw }], "replay")))).rejects.toMatchObject({ code: "task_update_final_output_started" });
      expect((await f.owner.taskUpdateState(f.token))!.finalOutputRevision).toBe(1);
      await expect(Promise.resolve().then(() => f.owner.requestCompaction(f.token, raw, context(1)))).rejects.toMatchObject({ code: "task_update_final_output_started" });
      const fence = await f.owner.beginCompletionFence(f.token, context(1));
      expect(await f.owner.commitCompletionFence(f.token, fence!, context(1))).toBe(true);
      expect(await f.owner.beginFinalOutput(f.token, context(1))).toEqual(receipt);
      expect(await f.owner.taskOutputReceipt(f.token)).toMatchObject({ kind: "completed", taskRevision: 1 });
    } finally { await f.close(); }
  });

  test("reserved outcomes survive refusal, cancellation, retries, and unknown lookup", async () => {
    const f = await fixture(remote);
    try {
      expect(await f.owner.taskUpdateTransferOutcome(f.token, "never-seen")).toEqual({ status: "unknown", transferId: "never-seen" });
      const value = f.transfer("abandoned", 0, [{ callId: "not-handed-off", result: raw }]);
      expect(await f.reserve(value)).toMatchObject({ status: "unknown" });
      await expect(Promise.resolve().then(() => f.owner.beginFinalOutput(f.token, context(0)))).rejects.toMatchObject({ code: "task_update_transfer_pending" });
      const refused = await f.owner.rejectTaskUpdateReservation(f.token, value.transferId, value.payloadDigest, context(0));
      expect(refused).toMatchObject({ status: "not_committed" });
      expect(await f.owner.acceptTaskUpdate(f.token, value)).toEqual(refused);
      expect(await f.owner.rejectTaskUpdateReservation(f.token, value.transferId, value.payloadDigest, context(0))).toEqual(refused);
      const pending = f.transfer("cancelled", 0, [{ callId: "not-handed-off", result: raw }]);
      await f.reserve(pending);
      await f.owner.revokeTrusted(f.token);
      expect(await f.owner.taskUpdateTransferOutcome(f.token, pending.transferId)).toMatchObject({ status: "not_committed", code: "codex_tool_operation_retired" });
      expect(await f.owner.acceptTaskUpdate(f.token, value)).toEqual(refused);
    } finally { await f.close(); }
  });

  test("capacity refusal preserves a real outstanding result and compaction excludes updates", async () => {
    const f = await fixture(remote);
    try {
      await f.start(1, 0);
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      const results = [{ callId: call!.callId, result: raw }];
      const oversized = f.transfer("oversized", 0, results, "results", "x".repeat(TASK_UPDATE_TOTAL_BYTES));
      expect(await f.accept(oversized)).toMatchObject({ status: "not_committed", code: "task_update_resource_limit" });
      expect(await f.wait(1)).toMatchObject({ kind: "pending" });
      await f.accept(f.transfer("bounded", 0, results));
      const delivery = (await f.wait(1)).taskUpdate!;
      await expect(Promise.resolve().then(() => f.owner.requestCompaction(f.token, raw, context(1)))).rejects.toMatchObject({ code: "task_update_pending" });
      await f.ack(delivery.deliveryId, 1);
      await f.owner.requestCompaction(f.token, raw, context(1));
      expect(await f.start(2, 0)).toMatchObject({ kind: "result", result: { structuredContent: { reason: "revision_mismatch" } } });
      expect(await f.owner.compactionDeliveryCount(f.token)).toBe(0);
      expect(await f.start(3, 1)).toMatchObject({ kind: "result", result: { _meta: { "codex/native-control": { kind: "compaction" } } } });
      expect(await f.owner.compactionDeliveryCount(f.token)).toBe(1);
      const compacted = await f.accept(f.transfer("compacted", 1, results, "replay"));
      expect(compacted).toMatchObject({ status: "not_committed", code: "task_update_compaction_pending" });
    } finally { await f.close(); }
  });

  test("Zero Risk completion declares the acknowledged revision and returns recovery delivery", async () => {
    const f = await fixture(remote, true);
    try {
      await f.start(1, 0);
      const [call] = await f.owner.nextToolBatch(f.token, undefined, context(0));
      await f.accept(f.transfer("safe", 0, [{ callId: call!.callId, result: raw }]));
      const delivery = (await f.wait(1)).taskUpdate!;
      const complete = (taskRevision?: number) => callTurnBroker(f.socket, { method: "safe_complete", token: f.token, finalAnswer: "latest final answer", taskRevision, taskUpdateProtocol: 1 });
      await expect(complete(0)).rejects.toMatchObject({ code: "task_update_unacknowledged", taskUpdate: delivery });
      await f.ack(delivery.deliveryId, 1);
      await expect(complete()).rejects.toMatchObject({ code: "task_update_unacknowledged" });
      expect(await complete(1)).toEqual({ completed: true, duplicate: false });
      expect(await complete(1)).toEqual({ completed: true, duplicate: true });
      expect(await f.owner.taskOutputReceipt(f.token)).toEqual({ kind: "completed", taskRevision: 1, driverGeneration: 1 });
      await expect(f.ack(delivery.deliveryId, 1)).rejects.toMatchObject({ code: "codex_tool_operation_retired" });
    } finally { await f.close(); }
  });
});

test("the bounded transfer journal rejects a new reservation before preparation", async () => {
  const f = await fixture(false);
  try {
    for (let index = 0; index < TASK_UPDATE_TRANSFER_LIMIT; index += 1) {
      const id = `reserved-${index}`;
      await f.owner.reserveTaskUpdate(f.token, id, id, context(0));
      await f.owner.rejectTaskUpdateReservation(f.token, id, id, context(0));
    }
    await expect(Promise.resolve().then(() => f.owner.reserveTaskUpdate(f.token, "overflow", "overflow", context(0)))).rejects.toMatchObject({ code: "task_update_resource_limit" });
    expect(await f.owner.taskUpdateTransferOutcome(f.token, "reserved-0")).toMatchObject({ status: "not_committed" });
    expect(await f.owner.beginFinalOutput(f.token, context(0))).toMatchObject({ taskRevision: 0 });
  } finally { await f.close(); }
});
