import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityRecoveryStore, continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { ContinuityTaskInputStore, TASK_INPUT_HISTORICAL_RETENTION_MS, type ReserveTaskInputDelivery, type TaskInputCoverage, type TaskInputStoreOptions } from "../src/adapters/chatgpt-web/continuity-task-input-store";
import { taskUpdateDigest } from "../src/adapters/chatgpt-web/task-update-source";

const roots: string[] = [];
const identity = { thread: "1".repeat(64), scope: "2".repeat(64), taskId: "task-A" };
const messages = [{ messageId: "A", text: "private original A" }, { messageId: "B", text: "private original B" }];
function fixture(options: TaskInputStoreOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cgw-task-input-")); roots.push(directory);
  new ContinuityRegistrationStore(directory).initialize();
  return { directory, store: new ContinuityTaskInputStore(directory, options), recovery: new ContinuityRecoveryStore(directory, options.recoveryOptions) };
}
function retentionFixture() {
  let now = 1_000;
  return { ...fixture({ recoveryOptions: { now: () => now } }), advance: () => { now += TASK_INPUT_HISTORICAL_RETENTION_MS + 1; } };
}
function delivery(overrides: Partial<ReserveTaskInputDelivery> = {}): ReserveTaskInputDelivery {
  return { deliveryId: "delivery-A", mode: "active", physicalResponseId: "physical-A", workLineageId: "lineage-A", logicalWorkId: "work-A",
    acceptedRevision: 0, acceptedTaskRevision: 4, driverGeneration: 1, historyRevision: 2, ...overrides };
}
function coverage(record: NonNullable<ReturnType<ContinuityTaskInputStore["reserveDelivery"]>>, messageIds = record.messageIds): TaskInputCoverage {
  return { ...record, messageIds };
}
function code(action: () => unknown): string | undefined { try { action(); return undefined; } catch (error) { return (error as { code: string }).code; } }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("durable custody preserves exact IDs, original text and server order without embedding text in metadata", () => {
  const { directory, store } = fixture();
  const accepted = store.receive(identity, [messages[0]!, { messageId: "same-text-new-ID", text: messages[0]!.text }]);
  expect(accepted.messages.map(message => [message.messageId, message.receivedSequence, message.status])).toEqual([["A", 1, "accepted"], ["same-text-new-ID", 2, "accepted"]]);
  expect(accepted.messages[0]!.digest).toBe(taskUpdateDigest(messages[0]!.text));
  const reopened = new ContinuityTaskInputStore(directory);
  expect(reopened.readBody(identity, "A")).toBe(messages[0]!.text);
  expect(reopened.receive(identity, [messages[0]!, messages[0]!])).toEqual(accepted);
  expect(readFileSync(join(directory, "recovery.json"), "utf8")).not.toContain("private original");
  expect(code(() => reopened.receive(identity, [{ messageId: "A", text: "replacement" }]))).toBe("task_update_message_conflict");
  expect(reopened.get({ ...identity, scope: "3".repeat(64) })).toBeUndefined();
  expect(reopened.listTasks({ thread: identity.thread })).toHaveLength(1);
});

test("ordered delivery freezes exact S and M/R/G/H; late input and discarded holes are not acknowledged or completed", () => {
  const { store } = fixture();
  store.receive(identity, [...messages, { messageId: "C", text: "C" }]);
  store.discard(identity, "B");
  const prepared = store.reserveDelivery(identity, delivery())!;
  expect(prepared.messageIds).toEqual(["A", "C"]);
  expect(prepared.receivedSequences).toEqual([1, 3]);
  expect(prepared.modelRevisions).toEqual([1, 2]);
  expect(prepared.acceptedRevision).toBe(2);
  expect(prepared.acceptedTaskRevision).toBe(4);
  expect(store.reserveDelivery(identity, delivery())).toEqual(prepared);
  store.receive(identity, [{ messageId: "D", text: "late D" }]);
  expect(code(() => store.reserveDelivery(identity, delivery({ deliveryId: "next", acceptedRevision: 2 })))).toBe("task_update_transfer_pending");
  expect(code(() => store.discard(identity, "A"))).toBe("task_update_not_executed");
  expect(code(() => store.acknowledge(identity, prepared.deliveryId, coverage(prepared)))).toBe("task_update_unacknowledged");
  store.markDelivered(identity, prepared.deliveryId, coverage(prepared));
  expect(code(() => store.acknowledge(identity, prepared.deliveryId, coverage(prepared, ["D"])))).toBe("task_update_stale");
  expect(code(() => store.acknowledge(identity, prepared.deliveryId, { ...coverage(prepared), physicalResponseId: "different" }))).toBe("task_update_stale");
  store.acknowledge(identity, prepared.deliveryId, coverage(prepared));
  const completed = store.complete(identity, prepared.deliveryId, coverage(prepared, ["A"]));
  expect(completed.messages.map(message => message.status)).toEqual(["completed", "discarded", "accepted", "accepted"]);
  expect(completed.state).toBe("active");
  const next = store.reserveDelivery(identity, delivery({ deliveryId: "next", acceptedRevision: 2, driverGeneration: 2 }))!;
  expect(next.messageIds).toEqual(["D"]);
});

test("initial snapshot starts at M/G=0 and Send alone cannot complete active input", () => {
  const { store } = fixture(); store.receive(identity, messages);
  const initial = store.reserveDelivery(identity, delivery({ mode: "initial", driverGeneration: 0 }))!;
  expect(initial.modelRevisions).toEqual([0, 0]);
  expect(code(() => store.complete(identity, initial.deliveryId, coverage(initial)))).toBe("task_update_unacknowledged");
  store.markDelivered(identity, initial.deliveryId, coverage(initial));
  expect(store.complete(identity, initial.deliveryId, coverage(initial)).state).toBe("completed");
  expect(store.receive(identity, [messages[0]!]).state).toBe("completed");
  const late = store.receive(identity, [{ messageId: "new", text: "new input" }]);
  expect(late.state).toBe("active");
  expect(late.receivedSequence).toBe(3);
  expect(late.deliveries).toHaveLength(1);
  const other = { ...identity, taskId: "active" }; store.receive(other, messages);
  const active = store.reserveDelivery(other, delivery())!;
  store.markDelivered(other, active.deliveryId, coverage(active));
  expect(code(() => store.complete(other, active.deliveryId, coverage(active)))).toBe("task_update_unacknowledged");
});

test("a successful later native turn preserves historical replay before retiring a completed inbox", () => {
  const { directory, store, recovery, advance } = retentionFixture();
  const first = { ...identity, taskId: `task_${taskUpdateDigest([identity.thread, "native-A"])}` };
  const owner = continuityProcessInstance();
  const admission = { thread: identity.thread, scope: identity.scope, owner, logicalWorkId: "work-A", nativeTurnId: "native-A",
    instructionIdentity: "instruction-A", workPayloadDigest: "3".repeat(64), snapshotDigest: "4".repeat(64),
    dispatchProtocolComplete: true, createPage: true };
  recovery.admitWork(admission);
  store.receive(first, messages);
  const sent = store.reserveDelivery(first, delivery({ mode: "initial", driverGeneration: 0 }))!;
  store.markDelivered(first, sent.deliveryId, coverage(sent)); store.complete(first, sent.deliveryId, coverage(sent));
  recovery.completeWork(identity.thread, recovery.get(identity.thread)!, "work-A", { receiptId: "final-A", digest: "5".repeat(64) });
  expect(store.get(first)?.retired).toBeUndefined(); // Same-turn late input remains legal.
  recovery.admitWork({ ...admission, logicalWorkId: "work-B", nativeTurnId: "native-B", instructionIdentity: "instruction-B", createPage: false });
  advance(); // A prepared successor cannot retire the protected old source.
  expect(store.get(first)?.retirementReadyAt).toBeUndefined();
  expect(store.get(first)?.retired).toBeUndefined();
  recovery.completeWork(identity.thread, recovery.get(identity.thread)!, "work-B", { receiptId: "final-B", digest: "6".repeat(64) });
  expect(store.get(first)?.retirementReadyAt).toBeDefined();
  expect(store.receive(first, messages).state).toBe("completed");
  const deadline = store.get(first)!.retirementReadyAt;
  expect(store.get(first)!.retirementReadyAt).toBe(deadline); // Reads do not renew retention.
  advance();
  expect(store.get(first)?.retired).toEqual({ reason: "completed", sequence: 2, compacted: false });
  expect(store.readBody(first, "A")).toBe(messages[0]!.text); // Fence precedes physical deletion.
  const before = store.usage().globalUsedBytes;
  const reopened = new ContinuityTaskInputStore(directory);
  expect(reopened.listTasks()[0]).toMatchObject({ messages: [], deliveries: [], receivedSequence: 2,
    retired: { reason: "completed", sequence: 2, compacted: true } });
  expect(reopened.usage().globalUsedBytes).toBeLessThan(before);
  expect(reopened.usage().bodyBytes).toBe(0);
  expect(code(() => reopened.receive(first, messages))).toBe("task_update_stale");
  recovery.removePage(identity.thread, recovery.get(identity.thread)!);
  expect(code(() => recovery.admitWork({ ...admission, logicalWorkId: "late-old-source" }))).toBe("continuity_stopped");
  expect(recovery.get(identity.thread)).toBeUndefined();
});

test("failed retirement compaction keeps its durable source fence and resumes cleanup after restart", () => {
  const { directory, store, recovery } = fixture();
  store.receive(identity, messages);
  let commits = 0;
  const failing = new ContinuityTaskInputStore(directory, { recoveryOptions: { beforeWrite: () => {
    if (++commits === 2) throw new Error("synthetic compaction persistence failure");
  } } });
  expect(code(() => failing.deleteTask(identity))).toBe("continuity_configuration_conflict");
  const reopened = new ContinuityTaskInputStore(directory);
  expect(reopened.get(identity)?.retired).toMatchObject({ reason: "deleted", compacted: false });
  expect(reopened.listTasks()[0]?.retired).toMatchObject({ compacted: true });
  expect(reopened.usage().bodyBytes).toBe(0);
  expect(code(() => reopened.receive(identity, messages))).toBe("task_update_stale");
});

test("completed inbox details can retire after page removal without treating the missing journal as execution authority", () => {
  const { directory, store, recovery, advance } = retentionFixture();
  const first = { ...identity, taskId: `task_${taskUpdateDigest([identity.thread, "native-A"])}` };
  const admission = { thread: identity.thread, scope: identity.scope, owner: continuityProcessInstance(),
    logicalWorkId: "work-A", nativeTurnId: "native-A", instructionIdentity: "instruction-A",
    workPayloadDigest: "3".repeat(64), snapshotDigest: "4".repeat(64), dispatchProtocolComplete: true, createPage: true };
  recovery.admitWork(admission); store.receive(first, messages);
  const sent = store.reserveDelivery(first, delivery({ mode: "initial", driverGeneration: 0 }))!;
  store.markDelivered(first, sent.deliveryId, coverage(sent)); store.complete(first, sent.deliveryId, coverage(sent));
  recovery.completeWork(identity.thread, recovery.get(identity.thread)!, "work-A", { receiptId: "final-A", digest: "5".repeat(64) });
  recovery.removePage(identity.thread, recovery.get(identity.thread)!);
  expect(store.get(first)?.retired).toBeUndefined();
  expect(store.readBody(first, "A")).toBe(messages[0]!.text);
  recovery.admitWork({ ...admission, logicalWorkId: "work-B", nativeTurnId: "native-B", instructionIdentity: "instruction-B" });
  recovery.completeWork(identity.thread, recovery.get(identity.thread)!, "work-B", { receiptId: "final-B", digest: "6".repeat(64) });
  expect(store.get(first)?.retired).toBeUndefined();
  advance();
  const reopened = new ContinuityTaskInputStore(directory);
  expect(reopened.listTasks()[0]?.retired).toMatchObject({ reason: "completed", compacted: true });
  expect(reopened.usage().bodyBytes).toBe(0);
  expect(recovery.get(identity.thread)?.currentWorkId).toBe("work-B");
});

test.each(["active", "stopped"] as const)("a later native turn does not reclaim %s input originals", state => {
  const { directory, store, recovery, advance } = retentionFixture();
  const first = { ...identity, taskId: `task_${taskUpdateDigest([identity.thread, "native-A"])}` };
  const admission = { thread: identity.thread, scope: identity.scope, owner: continuityProcessInstance(),
    logicalWorkId: "work-A", nativeTurnId: "native-A", instructionIdentity: "instruction-A",
    workPayloadDigest: "3".repeat(64), snapshotDigest: "4".repeat(64), dispatchProtocolComplete: true, createPage: true };
  recovery.admitWork(admission); store.receive(first, messages);
  if (state === "stopped") store.stop(first);
  recovery.removePage(identity.thread, recovery.get(identity.thread)!);
  recovery.admitWork({ ...admission, logicalWorkId: "work-B", nativeTurnId: "native-B", instructionIdentity: "instruction-B" });
  recovery.completeWork(identity.thread, recovery.get(identity.thread)!, "work-B", { receiptId: "final-B", digest: "6".repeat(64) });
  advance();
  const reopened = new ContinuityTaskInputStore(directory);
  expect(reopened.listTasks()[0]).toMatchObject({ state, receivedSequence: 2 });
  expect(reopened.get(first)?.retired).toBeUndefined();
  expect(reopened.readBody(first, "A")).toBe(messages[0]!.text);
  expect(reopened.readBody(first, "B")).toBe(messages[1]!.text);
  expect(reopened.usage().pendingMessages).toBe(2);
});

test("completed input coverage without settled source work cannot become a retirement proof after page removal", () => {
  const { store, recovery, advance } = retentionFixture();
  const first = { ...identity, taskId: `task_${taskUpdateDigest([identity.thread, "native-A"])}` };
  const admission = { thread: identity.thread, scope: identity.scope, owner: continuityProcessInstance(),
    logicalWorkId: "work-A", nativeTurnId: "native-A", instructionIdentity: "instruction-A",
    workPayloadDigest: "3".repeat(64), snapshotDigest: "4".repeat(64), dispatchProtocolComplete: true, createPage: true };
  recovery.admitWork(admission); store.receive(first, messages);
  const sent = store.reserveDelivery(first, delivery({ mode: "initial", driverGeneration: 0 }))!;
  store.markDelivered(first, sent.deliveryId, coverage(sent)); store.complete(first, sent.deliveryId, coverage(sent));
  expect(store.get(first)?.state).toBe("completed");
  expect(store.get(first)?.sourceSettled).toBeUndefined();
  recovery.removePage(identity.thread, recovery.get(identity.thread)!);
  recovery.admitWork({ ...admission, logicalWorkId: "work-B", nativeTurnId: "native-B", instructionIdentity: "instruction-B" });
  recovery.completeWork(identity.thread, recovery.get(identity.thread)!, "work-B", { receiptId: "final-B", digest: "6".repeat(64) });
  advance();
  expect(store.listTasks()[0]?.retired).toBeUndefined();
  expect(store.readBody(first, "A")).toBe(messages[0]!.text);
});

test.each(["before-input", "after-input"] as const)("proved canonical scope aliases preserve one inbox across page removal (%s)", order => {
  const { directory, store, recovery } = fixture();
  const canonical = { ...identity, scope: "6".repeat(64), taskId: `task_${taskUpdateDigest([identity.thread, "native-A"])}` };
  const legacy = { ...canonical, scope: identity.scope };
  const admission = { thread: identity.thread, scope: identity.scope, owner: continuityProcessInstance(),
    logicalWorkId: "work-A", nativeTurnId: "native-A", instructionIdentity: "instruction-A",
    workPayloadDigest: "3".repeat(64), snapshotDigest: "4".repeat(64), dispatchProtocolComplete: true, createPage: true };
  recovery.admitWork(admission);
  if (order === "after-input") store.receive(legacy, [messages[0]!]);
  recovery.bindCanonicalScope(identity.thread, { expectedScope: legacy.scope, canonicalScope: canonical.scope });
  if (order === "before-input") store.receive(legacy, [messages[0]!]);
  expect(store.get(canonical)?.canonicalScope).toBe(canonical.scope);
  expect(store.readBody(canonical, "A")).toBe(messages[0]!.text);
  store.receive(canonical, [messages[1]!]);
  expect(store.listTasks()).toHaveLength(1);
  expect(store.get(legacy)?.receivedSequence).toBe(2);
  expect(readdirSync(join(directory, "task-input-payloads"))).toHaveLength(2);
  store.stop(canonical);
  recovery.removePage(identity.thread, recovery.get(identity.thread)!);
  const reopened = new ContinuityTaskInputStore(directory);
  expect(reopened.get(canonical)?.state).toBe("stopped");
  expect(reopened.readBody(canonical, "B")).toBe(messages[1]!.text);
  expect(reopened.get({ ...canonical, scope: "7".repeat(64) })).toBeUndefined();
  reopened.retry(canonical, ["A", "B"]);
  expect(reopened.withExecutionIntent(canonical, 2, () => "current")).toBe("current");
  reopened.deleteTask(canonical);
  expect(code(() => recovery.admitWork({ ...admission, scope: canonical.scope, logicalWorkId: "old-canonical" }))).toBe("continuity_stopped");
  expect(code(() => reopened.receive(canonical, messages))).toBe("task_update_stale");
  // An unproved scope is still independent; an alias must never become thread-wide authority.
  recovery.admitWork({ ...admission, scope: "7".repeat(64), logicalWorkId: "other-scope" });
  expect(recovery.get(identity.thread)?.scope).toBe("7".repeat(64));
});

test.each(["before-retirement", "after-retirement"] as const)("completed source fences retain proved scope aliases when the page is removed %s", order => {
  const { directory, store, recovery, advance } = retentionFixture();
  const first = { ...identity, taskId: `task_${taskUpdateDigest([identity.thread, "native-A"])}` };
  const canonical = { ...first, scope: "6".repeat(64) };
  const admission = { thread: identity.thread, scope: identity.scope, owner: continuityProcessInstance(),
    logicalWorkId: "work-A", nativeTurnId: "native-A", instructionIdentity: "instruction-A",
    workPayloadDigest: "3".repeat(64), snapshotDigest: "4".repeat(64), dispatchProtocolComplete: true, createPage: true };
  recovery.admitWork(admission); store.receive(first, messages);
  recovery.bindCanonicalScope(identity.thread, { expectedScope: first.scope, canonicalScope: canonical.scope });
  const sent = store.reserveDelivery(canonical, delivery({ mode: "initial", driverGeneration: 0 }))!;
  store.markDelivered(canonical, sent.deliveryId, coverage(sent)); store.complete(canonical, sent.deliveryId, coverage(sent));
  recovery.completeWork(identity.thread, recovery.get(identity.thread)!, "work-A", { receiptId: "final-A", digest: "5".repeat(64) });
  expect(store.get(canonical)?.sourceSettled).toBe(true);
  if (order === "before-retirement") recovery.removePage(identity.thread, recovery.get(identity.thread)!);
  recovery.admitWork({ ...admission, scope: order === "before-retirement" ? canonical.scope : first.scope,
    logicalWorkId: "work-B", nativeTurnId: "native-B", instructionIdentity: "instruction-B", createPage: order === "before-retirement" });
  recovery.completeWork(identity.thread, recovery.get(identity.thread)!, "work-B", { receiptId: "final-B", digest: "6".repeat(64) });
  advance();
  expect(store.get(canonical)?.retired).toMatchObject({ reason: "completed", compacted: false });
  recovery.removePage(identity.thread, recovery.get(identity.thread)!);
  const reopened = new ContinuityTaskInputStore(directory);
  expect(reopened.listTasks()[0]).toMatchObject({ canonicalScope: canonical.scope, retired: { compacted: true } });
  expect(code(() => recovery.admitWork({ ...admission, scope: canonical.scope, logicalWorkId: "late-old-source" }))).toBe("continuity_stopped");
  expect(code(() => reopened.receive(canonical, messages))).toBe("task_update_stale");
  expect(recovery.get(identity.thread)).toBeUndefined();
});

test("retired-source checks share the actual writer-retirement lock and leave its successor unchanged", () => {
  const { store, recovery } = fixture();
  const old = { ...identity, taskId: `task_${taskUpdateDigest([identity.thread, "native-A"])}` };
  store.receive(old, messages); store.deleteTask(old);
  recovery.admitWork({ thread: identity.thread, scope: identity.scope, owner: continuityProcessInstance(),
    logicalWorkId: "successor", nativeTurnId: "native-B", instructionIdentity: "instruction-B",
    workPayloadDigest: "3".repeat(64), snapshotDigest: "4".repeat(64), dispatchProtocolComplete: true, createPage: true });
  const before = recovery.get(identity.thread)!;
  expect(code(() => recovery.retireAttempt(identity.thread, { scope: identity.scope, expectedVersion: before.version }, "successor", 0, old)))
    .toBe("continuity_stopped");
  expect(recovery.get(identity.thread)).toEqual(before);
});

test("a proved uncommitted delivery can return to the queue but its cancelled identity cannot authorize delivery or ACK", () => {
  const { store } = fixture(); store.receive(identity, messages);
  const first = store.reserveDelivery(identity, delivery())!;
  store.cancelReservedDelivery(identity, first.deliveryId, coverage(first));
  expect(store.get(identity)!.deliveries[0]!.cancelled).toBe(true);
  expect(code(() => store.reserveDelivery(identity, delivery()))).toBe("task_update_transfer_conflict");
  expect(code(() => store.markDelivered(identity, first.deliveryId, coverage(first)))).toBe("task_update_stale");
  store.discard(identity, "A");
  const second = store.reserveDelivery(identity, delivery({ deliveryId: "next" }))!;
  expect(second.messageIds).toEqual(["B"]);
  store.markDelivered(identity, second.deliveryId, coverage(second));
  expect(code(() => store.cancelReservedDelivery(identity, second.deliveryId, coverage(second)))).toBe("task_update_stale");
});

test("stop fences old dispatch and automatic retry; explicit retry retains the source intent and old delivery facts", () => {
  const { store } = fixture(); store.receive(identity, messages);
  const active = store.reserveDelivery(identity, delivery({ maxMessages: 1 }))!;
  const observed = store.get(identity)!;
  const stopped = store.stop(identity, { expectedVersion: observed.version, expectedIntentGeneration: 0 })!;
  expect(stopped.messages.map(message => message.status)).toEqual(["stopped", "stopped"]);
  expect(store.receive(identity, messages).state).toBe("stopped");
  expect(code(() => store.reserveDelivery(identity, delivery(), { expectedIntentGeneration: 0 }))).toBe("task_update_stale");
  expect(code(() => store.markDelivered(identity, active.deliveryId, coverage(active)))).toBe("task_update_stale");
  expect(code(() => store.cleanup(identity, ["B"]))).toBe("task_update_stale");
  const retried = store.retry(identity, ["A"], { expectedVersion: stopped.version, expectedIntentGeneration: stopped.intentGeneration })!;
  expect(retried.intentGeneration).toBe(2);
  expect(retried.messages[0]!.retryOfIntentGeneration).toBe(0);
  expect(retried.deliveries).toEqual(stopped.deliveries);
  expect(store.reserveDelivery(identity, delivery({ deliveryId: "explicit-retry" }))!.messageIds).toEqual(["A"]);
  expect(store.readBody(identity, "B")).toBe(messages[1]!.text);
});

test("payload loss pauses its prefix and matching-ID resubmission repairs text without changing S or completed delivery facts", () => {
  const { directory, store } = fixture(); store.receive(identity, messages);
  const files = readdirSync(join(directory, "task-input-payloads"));
  for (const file of files) writeFileSync(join(directory, "task-input-payloads", file), "damaged");
  expect(code(() => store.reserveDelivery(identity, delivery()))).toBe("continuity_context_missing");
  expect(store.get(identity)!.messages[0]!.payload).toBe("missing");
  expect(code(() => store.receive(identity, [{ messageId: "A", text: "different" }]))).toBe("task_update_message_conflict");
  store.receive(identity, messages);
  expect(store.get(identity)!.messages.map(message => message.receivedSequence)).toEqual([1, 2]);
  expect(store.reserveDelivery(identity, delivery())!.messageIds).toEqual(["A", "B"]);
});

for (const fault of ["reservation-after-rename", "payload-before-write", "payload-after-write", "accepted-after-rename"] as const) test(`interrupted ${fault} keeps a recoverable reservation and same-ID retry returns one accepted record`, () => {
  let enabled = true, commits = 0;
  const { directory, store } = fixture({ recoveryOptions: { afterAtomicReplace: () => {
    commits++;
    if (enabled && (fault === "reservation-after-rename" && commits === 1 || fault === "accepted-after-rename" && commits === 2)) throw new Error("injected sync failure");
  } }, beforePayloadWrite: () => { if (enabled && fault === "payload-before-write") throw new Error("injected disk failure"); },
  afterPayloadWrite: () => { if (enabled && fault === "payload-after-write") throw new Error("injected response loss"); } });
  let result: unknown;
  try { store.receive(identity, [messages[0]!]); } catch (error) { result = (error as { receiveStatus?: string }).receiveStatus; }
  expect(result).toBe("unknown"); enabled = false;
  const reopened = new ContinuityTaskInputStore(directory);
  const recovered = reopened.receive(identity, [messages[0]!]);
  expect(recovered.messages).toHaveLength(1);
  expect(recovered.messages[0]!.status).toBe("accepted");
  expect(recovered.receivedSequence).toBe(1);
  expect(reopened.readBody(identity, "A")).toBe(messages[0]!.text);
});

for (const boundary of ["beforePayloadWrite", "afterPayloadWrite", "accepted"] as const) test(`process exit at ${boundary} preserves custody and allows the original ID to finish after lock-owner recovery`, () => {
  const { directory } = fixture();
  // The sandbox can deny macOS process start-time queries. Replace only that OS
  // probe; the child exit, saved files and lock-owner reclamation remain real.
  const child = spawnSync(process.execPath, ["--eval", `import {spyOn} from "bun:test";import * as cp from "node:child_process";
    if(process.platform==="darwin")spyOn(cp,"execFileSync").mockImplementation(()=>"Mon Jan  1 00:00:00 2024");
    const {ContinuityTaskInputStore}=await import(${JSON.stringify(join(import.meta.dir, "../src/adapters/chatgpt-web/continuity-task-input-store.ts"))});
    let commits=0; const stop=()=>process.exit(73);
    const options=${boundary === "accepted" ? '{recoveryOptions:{afterAtomicReplace:()=>{if(++commits===2)stop()}}}' : `{${boundary}:stop}`};
    new ContinuityTaskInputStore(${JSON.stringify(directory)},options).receive(${JSON.stringify(identity)},${JSON.stringify(messages)});`], { encoding: "utf8", timeout: 10_000 });
  expect(child.status).toBe(73);
  const reopened = new ContinuityTaskInputStore(directory);
  expect(reopened.receive(identity, messages).messages.map(message => message.status)).toEqual(["accepted", "accepted"]);
  expect(reopened.get(identity)!.receivedSequence).toBe(2);
  expect(reopened.readBody(identity, "A")).toBe(messages[0]!.text);
});

test("an interrupted earlier reservation blocks later accepted messages until the original text is repaired", () => {
  let fail = true;
  const { directory, store } = fixture({ beforePayloadWrite: () => { if (fail) throw new Error("disk unavailable"); } });
  expect(() => store.receive(identity, [messages[0]!])).toThrow(); fail = false;
  const reopened = new ContinuityTaskInputStore(directory); reopened.receive(identity, [messages[1]!]);
  expect(code(() => reopened.reserveDelivery(identity, delivery()))).toBe("continuity_context_missing");
  reopened.receive(identity, [messages[0]!]);
  expect(reopened.reserveDelivery(identity, delivery())!.messageIds).toEqual(["A", "B"]);
});

test("pending task limits and the existing global recovery budget reject new text without eviction", () => {
  const { store } = fixture();
  store.receive(identity, Array.from({ length: 128 }, (_, i) => ({ messageId: `m${i}`, text: "x" })));
  expect(code(() => store.receive(identity, [{ messageId: "overflow", text: "x" }]))).toBe("continuity_resource_capacity");
  expect(store.list(identity)).toHaveLength(128);
  const byteTask = { ...identity, taskId: "bytes" };
  store.receive(byteTask, [{ messageId: "max", text: "x".repeat(1024 * 1024) }]);
  expect(code(() => store.receive(byteTask, [{ messageId: "overflow", text: "x" }]))).toBe("continuity_resource_capacity");
  const budget = fixture({ recoveryOptions: { limits: { totalBytes: 12_000 } } });
  budget.store.receive(identity, [messages[0]!]);
  expect(code(() => budget.store.receive({ ...identity, taskId: "other" }, [messages[0]!]))).toBe("continuity_resource_capacity");
  expect(budget.store.readBody(identity, "A")).toBe(messages[0]!.text);
  expect(budget.store.get({ ...identity, taskId: "other" })).toBeUndefined();
});

test("page removal and restart preserve custody; only explicit terminal cleanup releases bodies", () => {
  const { directory, store, recovery } = fixture();
  const owner = continuityProcessInstance();
  recovery.admitWork({ ...identity, owner, logicalWorkId: "work-A", instructionIdentity: "instruction-A", workPayloadDigest: "3".repeat(64), snapshotDigest: "4".repeat(64), dispatchProtocolComplete: true, createPage: true });
  store.receive(identity, messages);
  expect(recovery.removePage(identity.thread, recovery.get(identity.thread)!)).toBe(true);
  const reopened = new ContinuityTaskInputStore(directory);
  expect(reopened.readBody(identity, "A")).toBe(messages[0]!.text);
  reopened.discard(identity, "A"); reopened.cleanup(identity, ["A"]);
  expect(reopened.usage(identity).bodyBytes).toBe(Buffer.byteLength(messages[1]!.text));
  expect(reopened.receive(identity, [messages[0]!]).messages[0]!.payload).toBe("released");
  reopened.deleteTask(identity);
  expect(reopened.usage(identity).bodyBytes).toBe(0);
  expect(code(() => reopened.receive(identity, messages))).toBe("task_update_stale");
  expect(reopened.get(identity)?.retired).toMatchObject({ reason: "deleted", compacted: true });
  expect(reopened.usage(identity).messages).toBe(0);
});

test("a malformed recovery document with retained inbox data is never reset by disposable page repair", () => {
  const { directory, store, recovery } = fixture(); store.receive(identity, messages);
  const file = join(directory, "recovery.json"); writeFileSync(file, "broken");
  expect(() => recovery.promotePageLifetime()).toThrow();
  expect(readFileSync(file, "utf8")).toBe("broken");
  expect(readdirSync(join(directory, "task-input-payloads"))).toHaveLength(2);
});

test("the inbox consumes the existing recovery budget while earlier work keeps its reserved terminal writes", () => {
  const { directory } = fixture();
  const recovery = new ContinuityRecoveryStore(directory, { limits: { totalBytes: 12_000 } });
  const store = new ContinuityTaskInputStore(directory, { recoveryOptions: { limits: { totalBytes: 12_000 } } });
  const owner = continuityProcessInstance();
  recovery.admitWork({ ...identity, owner, logicalWorkId: "work-A", instructionIdentity: "instruction-A", workPayloadDigest: "3".repeat(64), snapshotDigest: "4".repeat(64), dispatchProtocolComplete: true, createPage: true });
  expect(code(() => store.receive(identity, [messages[0]!]))).toBe("continuity_resource_capacity");
  expect(store.get(identity)).toBeUndefined();
  expect(recovery.stopWork(identity.thread, { scope: identity.scope }, "work-A", "user-stop").works["work-A"]!.state).toBe("stopped");
  expect(store.usage().globalUsedBytes).toBe(recovery.capacityUsage().usedBytes);
  expect(store.usage().globalLimitBytes).toBe(12_000);
});

test("the actual side effect can check intent inside an existing recovery lock and stop revokes that exact intent", () => {
  const { store, recovery } = fixture(); store.receive(identity, messages);
  let dispatched = 0;
  recovery.withTaskInputTransaction(() => { store.assertExecutionIntent(identity, 0); dispatched++; });
  expect(dispatched).toBe(1);
  store.stop(identity);
  expect(code(() => recovery.withTaskInputTransaction(() => { store.assertExecutionIntent(identity, 0); dispatched++; }))).toBe("continuity_stopped");
  expect(dispatched).toBe(1);
});

test("all instances share one mutation lock and guards are checked at the commit boundary", () => {
  const { directory, store } = fixture(); store.receive(identity, [messages[0]!]);
  let checked = 0, output = "";
  store.receive(identity, [messages[1]!], { authorize: () => {
    checked++;
    const child = spawnSync(process.execPath, ["--eval", `import {ContinuityTaskInputStore} from ${JSON.stringify(join(import.meta.dir, "../src/adapters/chatgpt-web/continuity-task-input-store.ts"))}; try {new ContinuityTaskInputStore(${JSON.stringify(directory)}).stop(${JSON.stringify(identity)});process.stdout.write("changed")}catch(e){process.stdout.write(String(e).includes("busy")?"blocked":"other")}`], { encoding: "utf8", timeout: 10_000 });
    output = child.stdout;
  } });
  expect(checked).toBe(2); expect(output).toBe("blocked");
  const version = store.get(identity)!.version;
  expect(code(() => store.discard(identity, "B", { expectedVersion: version - 1 }))).toBe("task_update_stale");
  expect(store.list(identity)[1]!.status).toBe("accepted");
});

test("symlink payloads and unsafe file modes never supply or overwrite accepted text", () => {
  if (process.platform === "win32") return;
  const { directory, store } = fixture(); store.receive(identity, [messages[0]!]);
  const file = join(directory, "task-input-payloads", readdirSync(join(directory, "task-input-payloads"))[0]!);
  chmodSync(file, 0o644);
  expect(code(() => store.readBody(identity, "A"))).toBe("continuity_context_missing");
  expect(code(() => store.receive(identity, [messages[0]!]))).toBe("continuity_context_missing");
  rmSync(file); const external = join(directory, "external.txt"); writeFileSync(external, "keep", { mode: 0o600 }); symlinkSync(external, file);
  expect(code(() => store.readBody(identity, "A"))).toBe("continuity_context_missing");
  expect(code(() => store.receive(identity, [messages[0]!]))).toBe("continuity_context_missing");
  expect(readFileSync(external, "utf8")).toBe("keep");
});
