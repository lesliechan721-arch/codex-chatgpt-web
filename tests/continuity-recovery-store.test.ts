import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContinuityRecoveryStore, continuityProcessInstance, continuityProcessInstanceStatus,
  continuityLauncherInstanceStatus,
  withContinuityStorageLock, type AdmitRecoveryWorkInput, type RecoveryInstructionPrevious, type RecoveryThreadRecord,
  type RecoveryCompactionActivationIdentity,
} from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { parseRequest } from "../src/responses/parser";
import { chatGptContinuityInstructionPayloadDigest } from "../src/adapters/chatgpt-web/turn-execution";
import { recoveryContext, recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";

const roots: string[] = [];
const thread = "1".repeat(64), scope = "2".repeat(64), owner = continuityProcessInstance("3".repeat(64));
const payload = "4".repeat(64), snapshot = "5".repeat(64), result = "6".repeat(64);
const guard = { scope };
function fixture(options: ConstructorParameters<typeof ContinuityRecoveryStore>[1] = {}) {
  const path = mkdtempSync(join(tmpdir(), "cgw-recovery-store-")); roots.push(path);
  const registrations = new ContinuityRegistrationStore(path); registrations.initialize();
  return { path, registrations, store: new ContinuityRecoveryStore(path, options) };
}
function input(logicalWorkId = "work-A", extra: Partial<AdmitRecoveryWorkInput> = {}): AdmitRecoveryWorkInput {
  return { thread, scope, owner, logicalWorkId, instructionIdentity: `instruction-${logicalWorkId}`, nativeTurnId: "turn-A",
    workPayloadDigest: payload, snapshotDigest: snapshot, dispatchProtocolComplete: true, createPage: true, ...extra };
}
function batch(store: ContinuityRecoveryStore, callId = "call-A", work = "work-A", attempt = 0) {
  store.issueBatch(thread, guard, { logicalWorkId: work, attempt, localSessionId: `session-${attempt}`, localBatchId: callId,
    calls: [{ callId, operationId: `operation-${callId}`, expectedResultType: "function_call_output" }] });
  return store.markDeliveryPossible(thread, guard, [callId]);
}
function settle(store: ContinuityRecoveryStore, callId = "call-A", resultDigest = result) {
  return store.acceptResult(thread, guard, { callId, resultType: "function_call_output", resultDigest });
}
function targetId(record: RecoveryThreadRecord): string { return Object.keys(record.compactionTargets).at(-1)!; }
function activationIdentity(record: RecoveryThreadRecord, logicalWorkId = "compact-A"): RecoveryCompactionActivationIdentity {
  const attempt = record.works[logicalWorkId]!.attempts.at(-1)!;
  return { attempt: attempt.attempt, snapshotVersion: attempt.snapshotVersion, transactionId: attempt.transactionId!, transactionVersion: attempt.transactionVersion! };
}
function v1Fixture() {
  const value = fixture(); value.registrations.claim(thread, scope, owner.id);
  const marker = JSON.parse(readFileSync(join(value.path, "initialized.json"), "utf8")); delete marker.recoveryVersion;
  writeFileSync(join(value.path, "initialized.json"), JSON.stringify(marker));
  rmSync(join(value.path, "recovery.json")); rmSync(join(value.path, "recovery-initialized.json"));
  return value;
}
function preparedMigrationFixture(options: ConstructorParameters<typeof ContinuityRecoveryStore>[1] = {}) {
  const value = fixture(options);
  const previousOwner = { id: "7".repeat(64), pid: 2147483647, startIdentity: "darwin:Mon Jan  1 00:00:00 2024" };
  const launcherInstance = { pid: owner.pid, startIdentity: owner.startIdentity, instanceId: "8".repeat(64) };
  value.store.admitWork(input("work-A", { owner: previousOwner }));
  value.store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "page-possible", launcherInstance });
  value.store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "page-acquired", pageReceiptId: "old-page" });
  return { ...value, previousOwner, launcherInstance };
}
function shadow(store: ContinuityRecoveryStore, compactWork = "compact-A", sourceWork = "work-A") {
  const target = targetId(store.registerCompactionTarget(thread, guard, { sourceLogicalWorkId: sourceWork, sourceIdentity: `source-${sourceWork}` }));
  return store.admitWork(input(compactWork, { purpose: "compaction", compactionTargetId: target, createPage: false, activate: false }));
}
function checkpoint(store: ContinuityRecoveryStore, sourceWork = "work-A", compactWork = "compact-A", commitId = "commit-A", coveredCallIds: string[] = [], nativeTurnId = "turn-A") {
  let record = store.registerCompactionTarget(thread, guard, { sourceLogicalWorkId: sourceWork, sourceIdentity: `source-${sourceWork}`, representationDigests: [payload] });
  const id = targetId(record);
  store.retireAttempt(thread, guard, sourceWork, record.works[sourceWork]!.attempts.length - 1);
  store.admitWork(input(compactWork, { purpose: "compaction", compactionTargetId: id, createPage: false }));
  store.retireAttempt(thread, guard, compactWork, 0);
  return store.commitCheckpoint(thread, guard, { logicalWorkId: compactWork, compactionTargetId: id, commitId,
    summaryDigest: result, coveredCallIds, nativeTurnId });
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

for (const covered of [false, true]) for (const history of ["omitted", "edited"] as const) test(`recovery context checks only required results covered=${covered} history=${history}`, () => {
  const { path, store } = fixture();
  store.admitWork(input()); batch(store);
  const accepted = { type: "function_call_output", call_id: "call-A", output: "Real accepted result." };
  settle(store, "call-A", recoveryResultDigest(accepted));
  checkpoint(store, "work-A", "compact-A", "commit-A", covered ? ["call-A"] : []);
  const before = store.get(thread)!;
  expect(store.requiredCalls(thread, "work-A", "commit-A")).toHaveLength(covered ? 0 : 1);
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: [
    { type: "message", role: "user", content: "Continue the task." },
    ...(history === "edited" ? [{ ...accepted, output: "Edited client history." }] : []),
  ] });
  const recover = () => recoveryContext(parsed, { directory: path, thread, logicalWorkId: "work-A", attempt: 0 }, "commit-A");
  if (covered) {
    const recovered = recover();
    expect((recovered._rawBody as { input: unknown[] }).input).toEqual((parsed._rawBody as { input: unknown[] }).input);
  } else {
    expect(recover).toThrow(history === "edited" ? "conflicts with its first accepted result" : "requires its real result body");
  }
  expect(store.get(thread)).toEqual(before);
  expect(store.get(thread)!.calls["call-A"]!.firstResultDigest).toBe(recoveryResultDigest(accepted));
});

test("controlled initialization keeps installation and fails closed for missing or corrupt evidence", () => {
  const { path, store, registrations } = fixture();
  expect(store.installationId()).toMatch(/^[a-f0-9]{64}$/);
  expect(new ContinuityRecoveryStore(path).installationId()).toBe(store.installationId());
  store.admitWork(input());
  const file = join(path, "recovery.json"), original = readFileSync(file, "utf8");
  writeFileSync(file, "{"); expect(() => registrations.initialize()).toThrow("not reset"); expect(readFileSync(file, "utf8")).toBe("{");
  writeFileSync(file, original); rmSync(file); expect(() => registrations.initialize()).toThrow("not reset");
  rmSync(join(path, "recovery-initialized.json")); expect(() => registrations.initialize()).toThrow("missing");
  expect(() => store.admitWork(input())).toThrow("not initialized");
});

test("v1 entries remain legacy-unproven and cannot invent no-call or new-owner evidence", () => {
  const { path, registrations } = fixture();
  registrations.claim(thread, scope, owner.id);
  const marker = JSON.parse(readFileSync(join(path, "initialized.json"), "utf8")); delete marker.recoveryVersion;
  writeFileSync(join(path, "initialized.json"), JSON.stringify(marker));
  rmSync(join(path, "recovery.json")); rmSync(join(path, "recovery-initialized.json"));
  registrations.initialize();
  const store = new ContinuityRecoveryStore(path);
  expect(store.get(thread)?.legacyUnproven).toBe(true);
  expect(store.get(thread)?.owner.startIdentity).toBe("unverified");
  expect(registrations.get(thread)).toEqual({ scope, owner: owner.id, state: "entered" });
  expect(() => store.admitWork(input())).toThrow("v1");
  expect(() => registrations.compareAndSwap(thread, { scope, owner: owner.id, state: "entered" }, { owner: "7".repeat(64), state: "entered", epoch: 1 })).toThrow("evidence");
});

test("accepted work payload and first tool result are durable, and body fields cannot be stored", () => {
  const { path, store } = fixture();
  store.admitWork(input()); batch(store); settle(store);
  const reopened = new ContinuityRecoveryStore(path);
  expect(reopened.get(thread)?.calls["call-A"]?.firstResultDigest).toBe(result);
  expect(() => reopened.acceptResult(thread, guard, { callId: "call-A", resultType: "function_call_output", resultDigest: "7".repeat(64) })).toThrow("first accepted");
  expect(() => reopened.acceptResult(thread, guard, { callId: "call-A", resultType: "custom_tool_call_output", resultDigest: result })).toThrow("type");
  expect(() => reopened.admitWork(input("work-A", { workPayloadDigest: "7".repeat(64) }))).toThrow("payload");
  expect(() => reopened.admitWork(input("different-work", { instructionIdentity: "instruction-work-A" }))).toThrow("identity");
  expect(() => reopened.transact(thread, guard, record => { (record.works["work-A"] as unknown as Record<string, unknown>).prompt = "SECRET_PROMPT"; })).toThrow("schema");
  const disk = readFileSync(join(path, "recovery.json"), "utf8");
  expect(disk).not.toContain("SECRET_PROMPT"); expect(disk).not.toContain("https://"); expect(disk).not.toContain('"token"');
  expect(disk).not.toContain('"resultBody"'); expect(disk).not.toContain('"prompt"');
});

test("delivery and result write failures occur before externally visible success", () => {
  let fail = false;
  const { path, store } = fixture({ beforeWrite: () => { if (fail) throw new Error("injected write failure"); } });
  store.admitWork(input()); store.issueBatch(thread, guard, { logicalWorkId: "work-A", attempt: 0, calls: [{ callId: "call-A", operationId: "op-A", expectedResultType: "function_call_output" }] });
  let delivered = 0; fail = true;
  expect(() => { store.markDeliveryPossible(thread, guard, ["call-A"]); delivered++; }).toThrow("saved");
  expect(delivered).toBe(0); expect(new ContinuityRecoveryStore(path).get(thread)?.calls["call-A"]?.state).toBe("queued");
  fail = false; store.markDeliveryPossible(thread, guard, ["call-A"]); delivered++;
  fail = true; let resultAccepted = false;
  expect(() => { settle(store); resultAccepted = true; }).toThrow("saved");
  expect(resultAccepted).toBe(false); expect(new ContinuityRecoveryStore(path).get(thread)?.calls["call-A"]?.state).toBe("delivery-possible");
  fail = false; settle(store); expect(delivered).toBe(1);
});

test("a crashed delivery window is unknown and cannot be retired as an undelivered call", () => {
  const { path, store } = fixture(); store.admitWork(input()); batch(store);
  const restarted = new ContinuityRecoveryStore(path);
  restarted.retireAttempt(thread, guard, "work-A", 0);
  expect(restarted.get(thread)?.calls["call-A"]?.state).toBe("delivery-possible");
  expect(() => restarted.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot })).toThrow("terminal result");
  expect(() => restarted.transact(thread, guard, record => { record.calls["call-A"]!.state = "cancelled-before-delivery"; })).toThrow("undelivered");
  settle(restarted);
  const next = restarted.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot });
  expect(next.epoch).toBe(1); expect(next.calls["call-A"]!.state).toBe("settled");
});

test("queued calls can retire safely, but an empty Map does not prove complete dispatch coverage", () => {
  const { store } = fixture(); store.admitWork(input("work-A", { dispatchProtocolComplete: false }));
  store.retireAttempt(thread, guard, "work-A", 0);
  expect(() => store.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot })).toThrow("coverage");
  const safe = fixture().store; safe.admitWork(input());
  safe.issueBatch(thread, guard, { logicalWorkId: "work-A", attempt: 0, calls: [{ callId: "call-Q", operationId: "op-Q", expectedResultType: "function_call_output" }] });
  safe.retireAttempt(thread, guard, "work-A", 0);
  expect(safe.get(thread)?.calls["call-Q"]?.state).toBe("cancelled-before-delivery");
  expect(() => safe.markDeliveryPossible(thread, guard, ["call-Q"])).toThrow();
  expect(safe.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot }).epoch).toBe(1);
});

test("append preserves predecessor calls, durable sequence mappings, and stop covers the whole lineage", () => {
  const { path, store } = fixture(); store.admitWork(input("work-A", { localSessionId: "first-session", localTaskRevision: 0 }));
  batch(store); store.admitWork(input("work-B", { predecessorLogicalWorkId: "work-A", localSessionId: "first-session", localTaskRevision: 1, createPage: false }));
  settle(store); const restarted = new ContinuityRecoveryStore(path);
  expect(restarted.requiredCalls(thread, "work-B").map(call => call.callId)).toEqual(["call-A"]);
  expect(restarted.get(thread)?.works["work-B"]?.workLineageId).toBe("work-A");
  expect(restarted.get(thread)?.works["work-B"]?.acceptedTaskRevision).toBe(2);
  expect(Object.values(restarted.get(thread)!.lineages["work-A"]!.taskMappings).sort()).toEqual([1, 2]);
  restarted.stopWork(thread, guard, "work-B", "user-stop");
  expect(restarted.get(thread)?.works["work-A"]?.state).toBe("stopped"); expect(restarted.get(thread)?.works["work-B"]?.state).toBe("stopped");
  expect(() => restarted.completeWork(thread, guard, "work-A", { receiptId: "receipt", digest: result })).toThrow("stopped");
  const fresh = restarted.admitWork(input("work-C"));
  expect(fresh.epoch).toBe(1); expect(fresh.works["work-C"]!.workLineageId).toBe("work-C");
  expect(fresh.works["work-A"]!.state).toBe("stopped");
});

test("snapshot phase changes keep authorization stable; pre-send rebinding isolates late receipts", () => {
  const { store } = fixture(); const original = store.admitWork(input()); const version = original.transaction!.version;
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "page-possible", transactionVersion: version });
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "page-acquired", pageReceiptId: "lease-A", transactionVersion: version });
  expect(store.get(thread)!.transaction!.version).toBe(version);
  const rebound = store.rebindSnapshot(thread, guard, "work-A", "7".repeat(64));
  expect(rebound.transaction!.version).toBe(version + 1); expect(rebound.transaction!.snapshotVersion).toBe(1); expect(rebound.transaction!.pageReceiptId).toBeUndefined();
  expect(() => store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "send-possible", transactionVersion: version })).toThrow("old transaction");
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "send-possible", transactionVersion: version + 1 });
  expect(() => store.rebindSnapshot(thread, guard, "work-A", snapshot)).toThrow("sent");
});

test("recovery budgets survive restart and epochs, while one transaction owns successive attempts", () => {
  let now = 1000; const { path, store } = fixture({ now: () => now }); const first = store.admitWork(input()); const transactionId = first.transaction!.transactionId;
  for (let number = 0; number < 3; number++) {
    const current = new ContinuityRecoveryStore(path, { now: () => now });
    current.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: number, stage: "send-possible" }); current.retireAttempt(thread, guard, "work-A", number);
    const next = current.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot });
    expect(next.transaction!.transactionId).toBe(transactionId); expect(next.epoch).toBe(number + 1); expect(next.works["work-A"]!.retryBudget!.attempts).toBe(number + 2);
    expect(current.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot }).epoch).toBe(number + 1);
    now += 1000;
  }
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 3, stage: "send-possible" }); store.retireAttempt(thread, guard, "work-A", 3);
  expect(() => store.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot })).toThrow("exhausted");
  expect(store.get(thread)!.epoch).toBe(3);
});

test("checkpoint identity is stable and continuation is consumed atomically by only one consumer", () => {
  const { path, store } = fixture(); store.admitWork(input()); batch(store); settle(store);
  const first = checkpoint(store, "work-A", "compact-A", "commit-A", ["call-A"]);
  const id = first.checkpoints["commit-A"]!.compactionTargetId;
  expect(first.historyRevision).toBe(1); expect(first.epoch).toBe(0);
  expect(first.checkpoints["commit-A"]!.continuation.state).toBe("available");
  const consumer = input("work-B", { instructionIdentity: "instruction-work-A", createPage: false });
  const restarted = new ContinuityRecoveryStore(path);
  const accepted = restarted.consumeContinuation(thread, guard, "commit-A", consumer);
  expect(accepted.checkpoints["commit-A"]!.continuation.consumerLogicalWorkId).toBe("work-B");
  expect(accepted.works["work-B"]!.workLineageId).toBe("work-A"); expect(restarted.requiredCalls(thread, "work-B", "commit-A")).toEqual([]);
  expect(restarted.consumeContinuation(thread, guard, "commit-A", consumer).works["work-B"]!.attempts).toHaveLength(1);
  expect(() => restarted.consumeContinuation(thread, guard, "commit-A", { ...consumer, logicalWorkId: "work-C" })).toThrow("one consumer");
  expect(restarted.commitCheckpoint(thread, guard, { logicalWorkId: "compact-A", commitId: "commit-A", compactionTargetId: id, summaryDigest: result, coveredCallIds: ["call-A"] }).historyRevision).toBe(1);
  const second = checkpoint(restarted, "work-B", "compact-B", "commit-B", ["call-A"]);
  expect(second.historyRevision).toBe(2); expect(second.checkpoints["commit-B"]!.compactionTargetId).not.toBe(id);
  restarted.consumeContinuation(thread, guard, "commit-B", input("work-D", { instructionIdentity: "instruction-work-A", createPage: false }));
  restarted.retireAttempt(thread, guard, "work-D", 0);
  const recovered = restarted.reserveRecovery(thread, guard, { logicalWorkId: "work-D", owner, snapshotDigest: snapshot });
  expect(recovered.historyRevision).toBe(2); expect(recovered.works["work-D"]!.attempts[1]!.historyRevision).toBe(2);
});

test("checkpoint cannot cover an unknown delivered result", () => {
  const { store } = fixture(); store.admitWork(input()); batch(store);
  const record = shadow(store); const id = targetId(record);
  store.retireAttempt(thread, guard, "work-A", 0);
  store.retireAttempt(thread, guard, "compact-A", 0);
  expect(() => store.activateCompaction(thread, guard, "compact-A", activationIdentity(record))).toThrow("settlement");
  expect(() => store.commitCheckpoint(thread, guard, { logicalWorkId: "compact-A", commitId: "commit-A", compactionTargetId: id, summaryDigest: result, coveredCallIds: ["call-A"] })).toThrow("activated");
  expect(store.get(thread)!.historyRevision).toBe(0);
});

test("terminal space is reserved before delivery so full storage still accepts results and stop", () => {
  const { path, store } = fixture({ limits: { totalBytes: 7000 } }); store.admitWork(input());
  const accepted: string[] = [];
  for (let number = 0; number < 100; number++) {
    try { batch(store, `call-${number}`); accepted.push(`call-${number}`); }
    catch (error) { expect(String(error)).toContain("capacity"); break; }
  }
  expect(accepted.length).toBeGreaterThan(0); expect(accepted.length).toBeLessThan(100);
  // A successfully admitted queued call also remains reserved if delivery was the write that failed.
  const calls = Object.values(store.get(thread)!.calls);
  for (const call of calls) if (call.state === "delivery-possible") settle(store, call.callId);
  store.stopWork(thread, guard, "work-A", "native-interrupt");
  expect(new ContinuityRecoveryStore(path).get(thread)?.works["work-A"]?.state).toBe("stopped");
  expect(Object.values(new ContinuityRecoveryStore(path).get(thread)!.calls).every(call => ["settled", "cancelled-before-delivery"].includes(call.state))).toBe(true);
});

test("CAS isolates stale mutations and registration publication follows durable owner and epoch", () => {
  const { registrations, store } = fixture(); registrations.claim(thread, scope, owner.id); const first = store.admitWork(input());
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "page-possible" });
  expect(() => store.transact(thread, { scope, expectedVersion: first.version }, record => { record.state = "lost"; })).toThrow("stale");
  expect(() => registrations.compareAndSwap(thread, { scope, owner: owner.id, state: "entered" }, { owner: "7".repeat(64), state: "entered", epoch: 1 })).toThrow("evidence");
  store.retireAttempt(thread, guard, "work-A", 0); const replacementOwner = continuityProcessInstance("7".repeat(64));
  const next = store.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner: replacementOwner, snapshotDigest: snapshot });
  const published = registrations.compareAndSwap(thread, { scope, owner: owner.id, state: "entered" }, { owner: replacementOwner.id, state: "entered", epoch: next.epoch, transactionId: next.transaction!.transactionId });
  expect(published.epoch).toBe(1); expect(published.owner).toBe(replacementOwner.id);
  expect(() => registrations.compareAndSwap(thread, { scope, owner: owner.id, state: "entered" }, { owner: owner.id, state: "entered", epoch: 0 })).toThrow("stale");
});

test("locks do not use age; live or unverified instance keeps ownership, exited instance can be reaped", () => {
  const { path } = fixture(); const lock = join(path, "test.lock"); const file = `${process.pid}-${"1".repeat(32)}`;
  mkdirSync(lock, { mode: 0o700 }); writeFileSync(join(lock, file), JSON.stringify(owner), { mode: 0o600 });
  expect(() => withContinuityStorageLock(lock, () => true)).toThrow("busy"); expect(readFileSync(join(lock, file), "utf8")).toContain(owner.id);
  expect(continuityProcessInstanceStatus({ ...owner, startIdentity: "unverified" })).toBe("unverified");
  rmSync(lock, { recursive: true }); const deadPid = 2147483647; const deadFile = `${deadPid}-${"2".repeat(32)}`;
  const dead = { id: owner.id, pid: deadPid, startIdentity: "darwin:Mon Jan  1 00:00:00 2024" };
  mkdirSync(lock, { mode: 0o700 }); writeFileSync(join(lock, deadFile), JSON.stringify(dead), { mode: 0o600 });
  expect(continuityProcessInstanceStatus(dead)).toBe("exited"); expect(withContinuityStorageLock(lock, () => "acquired")).toBe("acquired");
});

test("pending checkpoint slots and body reservations share one budget with durable metadata", () => {
  const { path, store } = fixture({ limits: { totalBytes: 2 * 1024 * 1024 + 10_000, checkpoints: 1 } });
  store.admitWork(input());
  const reserved = store.registerCompactionTarget(thread, guard, { sourceLogicalWorkId: "work-A", sourceIdentity: "source-A" });
  const id = targetId(reserved);
  expect(() => store.registerCompactionTarget(thread, guard, { sourceLogicalWorkId: "work-A", sourceIdentity: "source-A", acceptedTaskRevision: 0 })).toThrow("256");
  store.retireAttempt(thread, guard, "work-A", 0);
  store.admitWork(input("compact-A", { purpose: "compaction", compactionTargetId: id, createPage: false }));
  store.retireAttempt(thread, guard, "compact-A", 0);
  expect(() => store.commitCheckpoint(thread, guard, { logicalWorkId: "compact-A", commitId: "commit-A", compactionTargetId: id, summaryDigest: result, coveredCallIds: [], retainedBodyBytes: 2 * 1024 * 1024 })).toThrow("metadata");
  const committed = store.commitCheckpoint(thread, guard, { logicalWorkId: "compact-A", commitId: "commit-A", compactionTargetId: id, summaryDigest: result, coveredCallIds: [], retainedBodyBytes: 1024 });
  expect(committed.checkpoints["commit-A"]!.retainedBodyBytes).toBe(1024);
  const encoded = readFileSync(join(path, "recovery.json"), "utf8"); expect(Buffer.byteLength(encoded) + 1024).toBeLessThan(2 * 1024 * 1024 + 10_000);
  const released = store.releaseCheckpointBodies(thread, guard, ["commit-A"]);
  expect(released.checkpoints["commit-A"]!.retainedBodyBytes).toBe(0);
  expect(released.checkpoints["commit-A"]!.summaryDigest).toBe(result); expect(released.checkpoints["commit-A"]!.continuation.state).toBe("available");
});

test("round and terminal identity slots reserve completion before new admission", () => {
  const { store } = fixture({ limits: { rounds: 1, tombstones: 1 } }); store.admitWork(input()); batch(store); settle(store);
  expect(() => batch(store, "call-B")).toThrow("512");
  store.completeWork(thread, guard, "work-A", { receiptId: "final-A", digest: result });
  expect(store.get(thread)!.works["work-A"]!.state).toBe("completed");
  expect(() => store.admitWork(input("work-B"))).toThrow("256");
  expect(store.get(thread)!.works["work-A"]!.terminalReceiptId).toBe("final-A");
  expect(() => store.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot })).toThrow("completed");
});

test("ordinary final result settles earlier accepted instructions without mutating retired attempts", () => {
  const { store } = fixture(); store.admitWork(input());
  store.admitWork(input("work-B", { predecessorLogicalWorkId: "work-A", createPage: false }));
  store.retireAttempt(thread, guard, "work-A", 0);
  const completed = store.completeWork(thread, guard, "work-B", { receiptId: "final-B", digest: result });
  expect(completed.works["work-A"]!.state).toBe("completed"); expect(completed.works["work-A"]!.attempts[0]!.stage).toBe("interrupted-settled");
  expect(completed.works["work-B"]!.state).toBe("completed");
  expect(() => store.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot })).toThrow("completed");
});

test("retry window does not reset on restart or delete pending tool evidence", () => {
  let now = 1000; const { path, store } = fixture({ now: () => now }); store.admitWork(input()); batch(store); settle(store);
  store.recordFailure(thread, guard, "work-A");
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "send-possible" }); store.retireAttempt(thread, guard, "work-A", 0);
  now += 30 * 60_000 + 1; const restarted = new ContinuityRecoveryStore(path, { now: () => now });
  expect(() => restarted.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot })).toThrow("exhausted");
  expect(restarted.get(thread)!.calls["call-A"]!.firstResultDigest).toBe(result);
});

test("concurrent processes reserve one recovery transaction and one successor attempt", async () => {
  const { path, store } = fixture(); store.admitWork(input());
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "send-possible" }); store.retireAttempt(thread, guard, "work-A", 0);
  const modulePath = join(import.meta.dir, "../src/adapters/chatgpt-web/continuity-recovery-store.ts");
  const source = `import { ContinuityRecoveryStore } from ${JSON.stringify(modulePath)};
    const store = new ContinuityRecoveryStore(${JSON.stringify(path)});
    for (let index=0; index<100; index++) {
      try { const record = store.reserveRecovery(${JSON.stringify(thread)}, ${JSON.stringify(guard)}, ${JSON.stringify({ logicalWorkId: "work-A", owner, snapshotDigest: snapshot })});
        process.stdout.write(JSON.stringify({transactionId:record.transaction.transactionId,epoch:record.epoch,attempt:record.transaction.attempt})); process.exit(0);
      } catch(error) { if (!String(error).includes('busy')) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5); }
    } throw new Error('timed out waiting for serialized transaction');`;
  const children = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async child => {
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(errors).toBe(""); expect(code).toBe(0); return JSON.parse(output);
  }));
  expect(new Set(results.map(record => record.transactionId)).size).toBe(1); expect(results.every(record => record.epoch === 1 && record.attempt === 1)).toBe(true);
  expect(store.get(thread)!.works["work-A"]!.attempts).toHaveLength(2); expect(store.get(thread)!.works["work-A"]!.retryBudget!.attempts).toBe(2);
});

test("legacy evidence cannot be promoted by an empty journal or an unverified process assertion", () => {
  const { path, registrations } = fixture(); registrations.claim(thread, scope, owner.id);
  const marker = JSON.parse(readFileSync(join(path, "initialized.json"), "utf8")); delete marker.recoveryVersion;
  writeFileSync(join(path, "initialized.json"), JSON.stringify(marker)); rmSync(join(path, "recovery.json")); rmSync(join(path, "recovery-initialized.json"));
  // Direct controlled initialization must discover old registrations too; callers cannot
  // omit the v1 table and accidentally initialize an empty proof of "no tool calls".
  const store = new ContinuityRecoveryStore(path); store.initialize(); const old = store.get(thread)!;
  expect(old.legacyUnproven).toBe(true);
  expect(() => store.adoptLegacyEvidence(thread, guard, { ...old, legacyUnproven: false, owner })).toThrow("complete actual");
});

test("oversized or secret-bearing record changes fail without replacing durable evidence", () => {
  const { path, store } = fixture(); store.admitWork(input()); const file = join(path, "recovery.json"), original = readFileSync(file, "utf8");
  expect(() => store.transact(thread, guard, record => { (record as unknown as Record<string, unknown>).url = "https://chatgpt.com/c/secret"; })).toThrow("schema");
  expect(readFileSync(file, "utf8")).toBe(original);
  const encoded = JSON.parse(original); encoded.threads[thread].works["work-A"].attempts[0].snapshotDigest = "bad-digest";
  writeFileSync(file, JSON.stringify(encoded)); expect(() => store.get(thread)).toThrow("not reset");
  writeFileSync(file, original); expect(() => new ContinuityRecoveryStore(path, { limits: { itemBytes: 1024 } }).admitWork(input("work-B"))).toThrow();
  expect(readFileSync(file, "utf8")).toBe(original);
});

test("recovery requires the current work and all predecessor writers, leaving refusals unchanged", () => {
  const { path, store } = fixture(); store.admitWork(input());
  store.admitWork(input("work-B", { predecessorLogicalWorkId: "work-A", createPage: false }));
  store.retireAttempt(thread, guard, "work-B", 0);
  const before = readFileSync(join(path, "recovery.json"), "utf8");
  expect(() => store.reserveRecovery(thread, guard, { logicalWorkId: "work-B", owner, snapshotDigest: snapshot })).toThrow("lineage writer");
  expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
  store.retireAttempt(thread, guard, "work-A", 0);
  const recovered = store.reserveRecovery(thread, guard, { logicalWorkId: "work-B", owner, snapshotDigest: snapshot });
  expect(recovered.currentWorkId).toBe("work-B"); expect(recovered.epoch).toBe(1);
  const active = fixture(); active.store.admitWork(input());
  active.store.admitWork(input("work-B", { predecessorLogicalWorkId: "work-A", createPage: false })); active.store.retireAttempt(thread, guard, "work-A", 0);
  const activeBefore = readFileSync(join(active.path, "recovery.json"), "utf8");
  expect(() => active.store.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot })).toThrow("current accepted");
  expect(readFileSync(join(active.path, "recovery.json"), "utf8")).toBe(activeBefore); expect(active.store.get(thread)!.currentWorkId).toBe("work-B");
});

test("only an explicit continuation may preserve source identity across a new work ID and mapped native turn", () => {
  const { store } = fixture(); store.admitWork(input()); checkpoint(store, "work-A", "compact-A", "commit-A", [], "continuation-turn");
  const consumer = input("consumer", { instructionIdentity: "instruction-work-A", nativeTurnId: "continuation-turn", createPage: false });
  expect(() => store.consumeContinuation(thread, guard, "commit-A", { ...consumer, instructionIdentity: "invented-item" })).toThrow("real source");
  expect(() => store.admitWork({ ...consumer, continuationCommitId: "commit-A", workPayloadDigest: result })).toThrow("real source");
  expect(() => store.consumeContinuation(thread, guard, "commit-A", { ...consumer, nativeTurnId: "turn-A" })).toThrow("native turn");
  const accepted = store.admitWork({ ...consumer, continuationCommitId: "commit-A" });
  expect(accepted.checkpoints["commit-A"]!.continuation.consumerLogicalWorkId).toBe("consumer");
  expect(accepted.works.consumer!.instructionIdentity).toBe("instruction-work-A"); expect(accepted.works.consumer!.nativeTurnId).toBe("continuation-turn");
  expect(() => store.admitWork({ ...consumer, logicalWorkId: "duplicate-without-commit" })).toThrow("identity");
  expect(store.consumeContinuation(thread, guard, "commit-A", consumer).works.consumer!.attempts).toHaveLength(1);
  store.retireAttempt(thread, guard, "consumer", 0);
  expect(store.reserveRecovery(thread, guard, { logicalWorkId: "consumer", owner, snapshotDigest: snapshot }).works.consumer!.attempts).toHaveLength(2);
});

for (const stopped of [false, true]) test(`a ${stopped ? "stopped" : "completed"} source cannot allocate a consumer through either admission API`, () => {
  const { path, store } = fixture(); store.admitWork(input()); checkpoint(store);
  if (stopped) store.stopWork(thread, guard, "work-A", "user-stop");
  else store.completeWork(thread, guard, "work-A", { receiptId: "ordinary-final", digest: result });
  const before = readFileSync(join(path, "recovery.json"), "utf8");
  const consumer = input("consumer", { instructionIdentity: "instruction-work-A", createPage: false });
  expect(() => store.consumeContinuation(thread, guard, "commit-A", consumer)).toThrow("completed or stopped source");
  expect(() => store.admitWork({ ...consumer, continuationCommitId: "commit-A" })).toThrow("completed or stopped source");
  expect(() => store.consumeContinuation(thread, guard, "commit-A", { ...consumer, instructionIdentity: "changed-item" })).toThrow("real source");
  expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
  const newWork = store.admitWork(input("new-user-work")); expect(newWork.works["new-user-work"]!.workLineageId).toBe("new-user-work");
  expect(newWork.checkpoints["commit-A"]!.continuation.state).toBe("available");
});

for (const stopped of [false, true]) test(`consumed original consumer retains its ${stopped ? "stop" : "final"} receipt on retry`, () => {
  const { store } = fixture(); store.admitWork(input()); checkpoint(store);
  const consumer = input("consumer", { instructionIdentity: "instruction-work-A", createPage: false }); store.consumeContinuation(thread, guard, "commit-A", consumer);
  if (stopped) store.stopWork(thread, guard, "consumer", "mode-exit");
  else store.completeWork(thread, guard, "consumer", { receiptId: "consumer-final", digest: result });
  const after = store.consumeContinuation(thread, guard, "commit-A", consumer);
  expect(after.works.consumer!.state).toBe(stopped ? "stopped" : "completed"); expect(after.works.consumer!.attempts).toHaveLength(1);
  expect(after.checkpoints["commit-A"]!.continuation.consumerLogicalWorkId).toBe("consumer");
  expect(() => store.consumeContinuation(thread, guard, "commit-A", { ...consumer, logicalWorkId: "new-consumer" })).toThrow("one consumer");
});

test("migration holds the registration lock through the actual journal write and format stamp", () => {
  const { path, registrations } = fixture(); registrations.claim(thread, scope, owner.id);
  const marker = JSON.parse(readFileSync(join(path, "initialized.json"), "utf8")); delete marker.recoveryVersion;
  writeFileSync(join(path, "initialized.json"), JSON.stringify(marker)); rmSync(join(path, "recovery.json")); rmSync(join(path, "recovery-initialized.json"));
  const concurrentThread = "8".repeat(64);
  const modulePath = join(import.meta.dir, "../src/adapters/chatgpt-web/continuity-registration.ts");
  const source = `import { ContinuityRegistrationStore } from ${JSON.stringify(modulePath)};
    try {new ContinuityRegistrationStore(${JSON.stringify(path)}).claim(${JSON.stringify(concurrentThread)},${JSON.stringify(scope)},${JSON.stringify(owner.id)});process.stdout.write('claimed');}
    catch(error){process.stdout.write(String(error).includes('busy')?'blocked':String(error));}`;
  const prototype = ContinuityRecoveryStore.prototype as unknown as { write: (document: unknown) => void };
  const originalWrite = prototype.write; let writes = 0;
  const fault = spyOn(prototype, "write").mockImplementation(function(this: ContinuityRecoveryStore, document: unknown) {
    writes++; const concurrent = spawnSync(process.execPath, ["--eval", source], { encoding: "utf8", timeout: 10_000 });
    expect(concurrent.status).toBe(0); expect(concurrent.stdout).toBe("blocked"); expect(concurrent.stderr).toBe("");
    return originalWrite.call(this, document);
  });
  try { registrations.initialize(); } finally { fault.mockRestore(); }
  expect(writes).toBe(1); expect(registrations.get(concurrentThread)).toBeUndefined();
  expect(new ContinuityRecoveryStore(path).get(thread)!.legacyUnproven).toBe(true);
  expect(JSON.parse(readFileSync(join(path, "initialized.json"), "utf8")).recoveryVersion).toBe(2);
});

test("a migration write failure retains the v1 snapshot and its durable upgrade intent cannot reset", () => {
  const { path, registrations } = fixture(); registrations.claim(thread, scope, owner.id);
  const marker = JSON.parse(readFileSync(join(path, "initialized.json"), "utf8")); delete marker.recoveryVersion;
  writeFileSync(join(path, "initialized.json"), JSON.stringify(marker)); rmSync(join(path, "recovery.json")); rmSync(join(path, "recovery-initialized.json"));
  const before = readFileSync(join(path, "threads.json"), "utf8");
  const prototype = ContinuityRecoveryStore.prototype as unknown as { write: (document: unknown) => void };
  const fault = spyOn(prototype, "write").mockImplementation(() => { throw new Error("injected migration write failure"); });
  try { expect(() => registrations.initialize()).toThrow("migration write failure"); } finally { fault.mockRestore(); }
  expect(readFileSync(join(path, "threads.json"), "utf8")).toBe(before);
  expect(JSON.parse(readFileSync(join(path, "initialized.json"), "utf8")).recoveryVersion).toBe(2);
  expect(() => registrations.initialize()).toThrow("not reset"); expect(() => new ContinuityRecoveryStore(path).admitWork(input())).toThrow("not reset");
});

for (const stopped of [false, true]) test(`cross-process ${stopped ? "stop" : "final"} and first continuation acceptance retain one terminal identity`, async () => {
  const { path, store } = fixture(); store.admitWork(input()); checkpoint(store);
  const consumer = input("consumer", { instructionIdentity: "instruction-work-A", createPage: false });
  const modulePath = join(import.meta.dir, "../src/adapters/chatgpt-web/continuity-recovery-store.ts");
  const consumerAction = `store.consumeContinuation(${JSON.stringify(thread)},${JSON.stringify(guard)},'commit-A',${JSON.stringify(consumer)});`;
  const terminalAction = stopped
    ? `store.stopWork(${JSON.stringify(thread)},${JSON.stringify(guard)},'work-A','user-stop');`
    : `store.completeWork(${JSON.stringify(thread)},${JSON.stringify(guard)},'work-A',{receiptId:'ordinary-final',digest:${JSON.stringify(result)}});`;
  const scripts = [consumerAction, terminalAction].map(action => `import {ContinuityRecoveryStore} from ${JSON.stringify(modulePath)};
    const store=new ContinuityRecoveryStore(${JSON.stringify(path)});
    for(let index=0;index<100;index++) {
      try {${action}process.stdout.write('accepted');process.exit(0);}
      catch(error){if(String(error).includes('busy')){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);continue;}
        if(String(error).includes('completed or stopped source')){process.stdout.write('source-terminal');process.exit(0);}throw error;}
    }throw new Error('transaction lock wait exceeded');`);
  const children = scripts.map(source => Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" }));
  const outcomes = await Promise.all(children.map(async child => {
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0); expect(errors).toBe(""); return output;
  }));
  expect(outcomes[1]).toBe("accepted"); expect(["accepted", "source-terminal"]).toContain(outcomes[0]!);
  const record = store.get(thread)!; expect(record.works["work-A"]!.state).toBe(stopped ? "stopped" : "completed");
  const relation = record.checkpoints["commit-A"]!.continuation;
  if (record.works.consumer) {
    expect(relation.consumerLogicalWorkId).toBe("consumer"); expect(record.works.consumer.state).toBe(stopped ? "stopped" : "completed"); expect(record.works.consumer.attempts).toHaveLength(1);
  } else expect(relation.state).toBe("available");
  expect(() => store.consumeContinuation(thread, guard, "commit-A", { ...consumer, logicalWorkId: "second-consumer" })).toThrow();
});

test("accepted instruction selection remains content-free and immutable across retries and recovery", () => {
  const { path, store } = fixture();
  const selection = { instructionIdentity: "previous-item", nativeTurnId: "previous-turn", checkpointDigest: result };
  const admitted = input("work-A", { instructionPrevious: selection, allowRetainedSourceFallback: true });
  store.admitWork(admitted);
  selection.instructionIdentity = "mutated-caller-item";
  const restarted = new ContinuityRecoveryStore(path); const previous = restarted.get(thread)!.works["work-A"]!.instructionPrevious!;
  expect(previous).toEqual({ instructionIdentity: "previous-item", nativeTurnId: "previous-turn", checkpointDigest: result });
  expect(restarted.get(thread)!.works["work-A"]!.allowRetainedSourceFallback).toBe(true);
  const accepted = { ...admitted, instructionPrevious: previous };
  expect(restarted.admitWork(accepted).works["work-A"]!.attempts).toHaveLength(1);
  expect(() => restarted.admitWork({ ...accepted, instructionPrevious: { ...previous, instructionIdentity: "different-previous-item" } })).toThrow("source selection");
  expect(() => restarted.admitWork({ ...accepted, allowRetainedSourceFallback: false })).toThrow("source selection");
  expect(() => restarted.transact(thread, guard, record => { record.works["work-A"]!.instructionPrevious = { ...previous, checkpointDigest: snapshot }; })).toThrow("source selection");
  restarted.retireAttempt(thread, guard, "work-A", 0); restarted.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot });
  expect(restarted.get(thread)!.works["work-A"]!.instructionPrevious).toEqual(previous);
  expect(restarted.get(thread)!.works["work-A"]!.allowRetainedSourceFallback).toBe(true);
  const disk = readFileSync(join(path, "recovery.json"), "utf8");
  expect(disk).not.toContain('"trustedLowerBound"'); expect(disk).not.toContain('"content"'); expect(disk).not.toContain('"prompt"');
});

test("selection metadata rejects plaintext, raw offsets, empty boundaries, and malformed checkpoint digests", () => {
  const { path, store } = fixture(); const original = readFileSync(join(path, "recovery.json"), "utf8");
  const bad = [ {}, { checkpointDigest: "not-a-digest" }, { instructionIdentity: "previous-item", trustedLowerBound: 1 },
    { instructionIdentity: "previous-item", content: "SECRET_INSTRUCTION" }, { instructionIdentity: "https://chatgpt.com/c/private" } ];
  for (const previous of bad) {
    expect(() => store.admitWork(input("work-A", { instructionPrevious: previous as RecoveryInstructionPrevious }))).toThrow();
    expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(original);
  }
});

test("persisted accepted selection compares every instruction in the original multi-item payload", () => {
  const { path, store } = fixture();
  const body = { model: "gpt-5.6-sol", input: [
    { type: "message", role: "user", id: "completed-item", content: "Completed previous instruction.", internal_chat_message_metadata_passthrough: { turn_id: "previous-turn" } },
    { type: "message", role: "assistant", content: "Previous answer." },
    { type: "message", role: "user", id: "accepted-a", content: "Accepted instruction A.", internal_chat_message_metadata_passthrough: { turn_id: "turn-A" } },
    { type: "message", role: "user", id: "accepted-b", content: "Accepted instruction B.", internal_chat_message_metadata_passthrough: { turn_id: "turn-A" } },
  ], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "native-thread", turn_id: "turn-A" }) } };
  const parsed = parseRequest(body); parsed._conversationPolicy = "continuity-first";
  const previous = { instructionIdentity: "completed-item", nativeTurnId: "previous-turn" };
  const acceptedDigest = chatGptContinuityInstructionPayloadDigest(parsed, previous, false);
  store.admitWork(input("work-A", { instructionIdentity: "accepted-b", instructionPrevious: previous,
    allowRetainedSourceFallback: false, workPayloadDigest: acceptedDigest }));
  const recorded = new ContinuityRecoveryStore(path).get(thread)!.works["work-A"]!;
  expect(chatGptContinuityInstructionPayloadDigest(parsed, recorded.instructionPrevious, recorded.allowRetainedSourceFallback)).toBe(recorded.workPayloadDigest);
  const edited = structuredClone(body); edited.input[2]!.content = "Modified earlier instruction A.";
  const changed = parseRequest(edited); changed._conversationPolicy = "continuity-first";
  expect(chatGptContinuityInstructionPayloadDigest(changed, recorded.instructionPrevious, recorded.allowRetainedSourceFallback)).not.toBe(recorded.workPayloadDigest);
  expect(recorded.instructionIdentity).toBe("accepted-b");
  const disk = readFileSync(join(path, "recovery.json"), "utf8"); expect(disk).not.toContain("Accepted instruction"); expect(disk).not.toContain("Previous answer");
});

test("a checkpoint consumer preserves source payload while retaining its own accepted checkpoint selection", () => {
  const { path, store } = fixture(); store.admitWork(input("work-A", {
    instructionPrevious: { instructionIdentity: "older-item", nativeTurnId: "older-turn" }, allowRetainedSourceFallback: false }));
  checkpoint(store, "work-A", "compact-A", "commit-A", [], "continuation-turn");
  const consumer = input("consumer", { instructionIdentity: "instruction-work-A", nativeTurnId: "continuation-turn", createPage: false,
    instructionPrevious: { instructionIdentity: "instruction-work-A", nativeTurnId: "turn-A", checkpointDigest: result }, allowRetainedSourceFallback: true });
  store.consumeContinuation(thread, guard, "commit-A", consumer);
  const reopened = new ContinuityRecoveryStore(path); const record = reopened.get(thread)!;
  expect(record.works.consumer!.workPayloadDigest).toBe(record.works["work-A"]!.workPayloadDigest);
  expect(record.works.consumer!.instructionPrevious).toEqual(consumer.instructionPrevious);
  expect(record.works.consumer!.allowRetainedSourceFallback).toBe(true);
  expect(() => reopened.consumeContinuation(thread, guard, "commit-A", { ...consumer, instructionPrevious: record.works["work-A"]!.instructionPrevious })).toThrow("source selection");
  expect(reopened.consumeContinuation(thread, guard, "commit-A", consumer).works.consumer!.attempts).toHaveLength(1);
});

test("healthy compaction admits its first control durably without replacing source authority", () => {
  const { path, store } = fixture(); const source = store.admitWork(input());
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "accepted" });
  const before = store.get(thread)!; const admitted = shadow(store); const control = admitted.works["compact-A"]!;
  expect(admitted.currentWorkId).toBe("work-A"); expect(admitted.state).toBe(before.state);
  expect(admitted.transaction).toEqual(before.transaction); expect(admitted.epoch).toBe(source.epoch);
  expect(control.activationState).toBe("shadow"); expect(control.workPayloadDigest).toBe(payload);
  expect(control.retryBudget!.attempts).toBe(1); expect(control.attempts).toHaveLength(1);
  expect(control.attempts[0]!.transactionId).not.toBe(before.transaction!.transactionId);
  const observed = activationIdentity(admitted);
  const sent = store.markAttempt(thread, guard, { logicalWorkId: "compact-A", attempt: 0, stage: "send-possible", transactionVersion: observed.transactionVersion });
  expect(sent.transaction).toEqual(before.transaction); expect(sent.currentWorkId).toBe("work-A");
  expect(new ContinuityRecoveryStore(path).get(thread)!.works["compact-A"]!.attempts[0]!.stage).toBe("send-possible");
  expect(() => store.issueBatch(thread, guard, { logicalWorkId: "compact-A", attempt: 0, calls: [{ callId: "control-call", operationId: "control-op", expectedResultType: "function_call_output" }] })).toThrow("business tool");
  expect(() => store.markAttempt(thread, guard, { logicalWorkId: "compact-A", attempt: 0, stage: "accepted", pageReceiptId: "new-page" })).toThrow("replacement page");
  expect(() => store.admitWork(input("compact-A", { purpose: "compaction", compactionTargetId: control.compactionTargetId, createPage: false, activate: false, workPayloadDigest: result }))).toThrow("payload");
});

test("shadow admission requires the actual current target and cannot bypass ordinary writer guards", () => {
  const { path, store } = fixture(); store.admitWork(input());
  const target = targetId(store.registerCompactionTarget(thread, guard, { sourceLogicalWorkId: "work-A", sourceIdentity: "source-A" }));
  const valid = input("compact-A", { purpose: "compaction", compactionTargetId: target, createPage: false, activate: false });
  const before = readFileSync(join(path, "recovery.json"), "utf8");
  for (const changed of [ { purpose: "ordinary" }, { createPage: true }, { dispatchProtocolComplete: false },
    { predecessorLogicalWorkId: "work-A" }, { compactionTargetId: "missing-target" }, { owner: { ...owner, id: "7".repeat(64) } } ]) {
    expect(() => store.admitWork({ ...valid, ...changed } as AdmitRecoveryWorkInput)).toThrow();
    expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
  }
  expect(() => store.admitWork({ ...valid, activate: true })).toThrow("retired");
  expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
  store.admitWork(input("work-B", { predecessorLogicalWorkId: "work-A", createPage: false }));
  expect(() => store.admitWork(valid)).toThrow("current accepted source");
  const next = shadow(store, "compact-B", "work-B");
  expect(next.currentWorkId).toBe("work-B");
  expect(() => shadow(store, "compact-C", "work-B")).toThrow("has not retired");
});

test("activation requires source and append writers retired plus all delivered tool results", () => {
  const { path, store } = fixture(); store.admitWork(input()); batch(store);
  store.admitWork(input("work-B", { predecessorLogicalWorkId: "work-A", createPage: false }));
  const admitted = shadow(store, "compact-A", "work-B"); const observed = activationIdentity(admitted);
  const before = readFileSync(join(path, "recovery.json"), "utf8");
  expect(() => store.activateCompaction(thread, guard, "compact-A", observed)).toThrow("writers");
  expect(() => store.transact(thread, guard, record => { record.works["compact-A"]!.activationState = "active"; })).toThrow("writers");
  expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
  store.retireAttempt(thread, guard, "work-B", 0);
  expect(() => store.activateCompaction(thread, guard, "compact-A", observed)).toThrow("writers");
  store.retireAttempt(thread, guard, "work-A", 0);
  expect(() => store.activateCompaction(thread, guard, "compact-A", observed)).toThrow("settlement");
  settle(store); const ready = store.get(thread)!;
  const activated = store.activateCompaction(thread, { ...guard, expectedVersion: ready.version }, "compact-A", observed);
  expect(activated.currentWorkId).toBe("compact-A"); expect(activated.epoch).toBe(admitted.epoch);
  expect(activated.works["compact-A"]!.attempts).toEqual(admitted.works["compact-A"]!.attempts);
  expect(activated.works["compact-A"]!.retryBudget).toEqual(admitted.works["compact-A"]!.retryBudget);
  expect(activated.transaction!.transactionId).toBe(observed.transactionId);
  expect(() => store.activateCompaction(thread, { ...guard, expectedVersion: ready.version }, "compact-A", observed)).toThrow("stale");
  expect(store.activateCompaction(thread, guard, "compact-A", observed).works["compact-A"]!.attempts).toHaveLength(1);
});

test("shadow snapshot rebinding rejects late activation and never changes the source transaction", () => {
  const { store } = fixture(); store.admitWork(input()); const admitted = shadow(store); const old = activationIdentity(admitted);
  const rebound = store.rebindSnapshot(thread, guard, "compact-A", result); const current = activationIdentity(rebound);
  expect(current.transactionVersion).toBe(old.transactionVersion + 1); expect(current.snapshotVersion).toBe(old.snapshotVersion + 1);
  expect(rebound.transaction).toEqual(admitted.transaction);
  store.retireAttempt(thread, guard, "work-A", 0);
  expect(() => store.activateCompaction(thread, guard, "compact-A", old)).toThrow("different admitted attempt");
  const activated = store.activateCompaction(thread, guard, "compact-A", current);
  expect(activated.transaction!.snapshotDigest).toBe(result); expect(activated.works["compact-A"]!.retryBudget!.attempts).toBe(1);
  store.retireAttempt(thread, guard, "compact-A", 0);
  store.reserveRecovery(thread, guard, { logicalWorkId: "compact-A", owner, snapshotDigest: snapshot });
  expect(() => store.activateCompaction(thread, guard, "compact-A", current)).toThrow("different admitted attempt");
});

test("failed shadow control retains its budget across restart, retirement, activation and recovery", () => {
  let now = 1000; const { path, store } = fixture({ now: () => now }); store.admitWork(input()); const admitted = shadow(store);
  const observed = activationIdentity(admitted); const before = store.get(thread)!;
  store.markAttempt(thread, guard, { logicalWorkId: "compact-A", attempt: 0, stage: "send-possible" });
  now += 5000; store.recordFailure(thread, guard, "compact-A");
  const retired = store.retireAttempt(thread, guard, "compact-A", 0);
  expect(retired.currentWorkId).toBe("work-A"); expect(retired.state).toBe(before.state); expect(retired.transaction).toEqual(before.transaction);
  const reopened = new ContinuityRecoveryStore(path, { now: () => now }); reopened.retireAttempt(thread, guard, "work-A", 0);
  const activated = reopened.activateCompaction(thread, guard, "compact-A", observed);
  expect(activated.state).toBe("lost"); expect(activated.works["compact-A"]!.attempts[0]!.writerRetired).toBe(true);
  expect(() => reopened.markAttempt(thread, guard, { logicalWorkId: "compact-A", attempt: 0, stage: "accepted" })).toThrow("late observer");
  const recovered = reopened.reserveRecovery(thread, guard, { logicalWorkId: "compact-A", owner, snapshotDigest: snapshot });
  expect(recovered.works["compact-A"]!.attempts).toHaveLength(2); expect(recovered.works["compact-A"]!.retryBudget!.attempts).toBe(2);
  expect(recovered.works["compact-A"]!.retryBudget!.startedAt).toBe(now); expect(recovered.transaction!.transactionId).toBe(observed.transactionId);
  expect(recovered.epoch).toBe(1); expect(recovered.works["work-A"]!.attempts).toHaveLength(1);
});

test("stops and advanced source boundaries prevent shadow activation while true final receipts survive", () => {
  for (const stopFirst of [true, false]) {
    const { store } = fixture(); store.admitWork(input()); const admitted = shadow(store); const observed = activationIdentity(admitted);
    if (!stopFirst) { store.retireAttempt(thread, guard, "work-A", 0); store.activateCompaction(thread, guard, "compact-A", observed); }
    store.stopWork(thread, guard, "work-A", "user-stop");
    expect(() => store.activateCompaction(thread, guard, "compact-A", observed)).toThrow("stopped");
    expect(store.get(thread)!.works["compact-A"]!.retryBudget).toBeUndefined();
  }
  const { store } = fixture(); store.admitWork(input()); const admitted = shadow(store);
  const final = store.completeWork(thread, guard, "work-A", { receiptId: "real-ordinary-final", digest: result });
  expect(final.currentWorkId).toBe("work-A");
  const activated = store.activateCompaction(thread, guard, "compact-A", activationIdentity(admitted));
  expect(activated.works["work-A"]!.terminalReceiptId).toBe("real-ordinary-final");
  store.retireAttempt(thread, guard, "compact-A", 0);
  expect(store.commitCheckpoint(thread, guard, { logicalWorkId: "compact-A", commitId: "commit-A", compactionTargetId: targetId(admitted),
    summaryDigest: result, coveredCallIds: [], ordinaryFinalReceiptId: "real-ordinary-final" }).checkpoints["commit-A"]!.ordinaryFinalReceiptId).toBe("real-ordinary-final");
  const advanced = fixture().store; advanced.admitWork(input()); const stale = shadow(advanced); batch(advanced); settle(advanced); advanced.retireAttempt(thread, guard, "work-A", 0);
  expect(() => advanced.activateCompaction(thread, guard, "compact-A", activationIdentity(stale))).toThrow("stable target boundary");
});

test("unactivated shadow success and failed shadow persistence cannot publish control rights", () => {
  let fail = false; const { path, store } = fixture({ beforeWrite: () => { if (fail) throw new Error("failed shadow write"); } }); store.admitWork(input());
  const target = targetId(store.registerCompactionTarget(thread, guard, { sourceLogicalWorkId: "work-A", sourceIdentity: "source-work-A" }));
  fail = true; let controls = 0;
  expect(() => { store.admitWork(input("compact-A", { purpose: "compaction", compactionTargetId: target, createPage: false, activate: false })); controls++; }).toThrow("saved");
  expect(controls).toBe(0); expect(new ContinuityRecoveryStore(path).get(thread)!.works["compact-A"]).toBeUndefined();
  fail = false; const admitted = shadow(store); store.retireAttempt(thread, guard, "compact-A", 0);
  expect(() => store.completeWork(thread, guard, "compact-A", { receiptId: "fake-final", digest: result })).toThrow("checkpoint commit");
  expect(() => store.commitCheckpoint(thread, guard, { logicalWorkId: "compact-A", commitId: "commit-A", compactionTargetId: target,
    summaryDigest: result, coveredCallIds: [] })).toThrow("activated");
  expect(() => store.transact(thread, guard, record => { record.works["compact-A"]!.state = "completed"; })).toThrow("unactivated shadow");
  expect(store.get(thread)!.currentWorkId).toBe("work-A"); expect(store.get(thread)!.transaction!.transactionId).not.toBe(activationIdentity(admitted).transactionId);
  const capacity = fixture({ limits: { tombstones: 1 } }).store; capacity.admitWork(input());
  expect(() => shadow(capacity)).toThrow("256"); expect(capacity.get(thread)!.works["compact-A"]).toBeUndefined();
});

test("a long-running task first loss starts the recovery window and still requires real tool settlement", () => {
  let now = 1000; const { path, store } = fixture({ now: () => now }); store.admitWork(input());
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "accepted" }); batch(store);
  now += 2 * 60 * 60_000; const firstLoss = now; store.recordFailure(thread, guard, "work-A"); store.retireAttempt(thread, guard, "work-A", 0);
  const reopened = new ContinuityRecoveryStore(path, { now: () => now });
  expect(() => reopened.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot })).toThrow("terminal result");
  expect(reopened.get(thread)!.epoch).toBe(0); expect(reopened.get(thread)!.calls["call-A"]!.state).toBe("delivery-possible");
  settle(reopened); const recovered = reopened.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot });
  expect(recovered.epoch).toBe(1); expect(recovered.works["work-A"]!.retryBudget!.startedAt).toBe(firstLoss);
  expect(recovered.works["work-A"]!.retryBudget!.attempts).toBe(2);
  now += 10 * 60_000; reopened.recordFailure(thread, guard, "work-A");
  reopened.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 1, stage: "send-possible" }); reopened.retireAttempt(thread, guard, "work-A", 1);
  now = firstLoss + 30 * 60_000 + 1;
  const restarted = new ContinuityRecoveryStore(path, { now: () => now });
  expect(() => restarted.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot })).toThrow("exhausted");
  const remaining = restarted.get(thread)!; expect(remaining.epoch).toBe(1); expect(remaining.works["work-A"]!.retryBudget!.startedAt).toBe(firstLoss);
  expect(remaining.calls["call-A"]!.firstResultDigest).toBe(result); expect(remaining.works["work-A"]!.attempts).toHaveLength(2);
});

test("restart without first-failure evidence anchors once and permits only three successor attempts", () => {
  let now = 1000; const { path, store } = fixture({ now: () => now }); store.admitWork(input());
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "accepted" }); store.retireAttempt(thread, guard, "work-A", 0);
  now += 2 * 60 * 60_000; const firstRecovery = now;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const reopened = new ContinuityRecoveryStore(path, { now: () => now });
    const recovered = reopened.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot });
    expect(recovered.works["work-A"]!.retryBudget!.startedAt).toBe(firstRecovery);
    expect(recovered.works["work-A"]!.retryBudget!.attempts).toBe(attempt + 1);
    reopened.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt, stage: "send-possible" }); reopened.retireAttempt(thread, guard, "work-A", attempt);
    now += 1000; reopened.recordFailure(thread, guard, "work-A");
  }
  const final = new ContinuityRecoveryStore(path, { now: () => now }); const before = readFileSync(join(path, "recovery.json"), "utf8");
  expect(() => final.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot })).toThrow("exhausted");
  expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before); expect(final.get(thread)!.works["work-A"]!.attempts).toHaveLength(4);
});

test("a later history target admits compaction only through the exact current successful source commit", () => {
  const { path, store } = fixture(); store.admitWork(input()); const first = checkpoint(store);
  const target = targetId(store.registerCompactionTarget(thread, guard, { sourceLogicalWorkId: "work-A", sourceIdentity: "source-work-A", sourceHistoryRevision: 1 }));
  const next = input("compact-B", { purpose: "compaction", compactionTargetId: target, createPage: true });
  const before = readFileSync(join(path, "recovery.json"), "utf8");
  expect(() => store.admitWork({ ...next, activate: false, createPage: false })).toThrow("current accepted source");
  expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
  const second = store.admitWork(next);
  expect(second.currentWorkId).toBe("compact-B"); expect(second.epoch).toBe(1); expect(second.historyRevision).toBe(first.historyRevision);
  expect(second.lineages["work-A"]!.headLogicalWorkId).toBe("work-A"); expect(second.works["compact-A"]!.state).toBe("completed");
  store.retireAttempt(thread, guard, "compact-B", 0);
  expect(store.commitCheckpoint(thread, guard, { logicalWorkId: "compact-B", compactionTargetId: target, commitId: "commit-B", summaryDigest: result, coveredCallIds: [] }).historyRevision).toBe(2);
  expect(() => store.admitWork(input("compact-old", { purpose: "compaction", compactionTargetId: target, createPage: false }))).toThrow("stable target boundary");
});

test("all public migration entries reject supplied snapshots and obey the registration lock", () => {
  const { path, store } = v1Fixture(); const before = readFileSync(join(path, "threads.json"), "utf8");
  expect(() => (store.initialize as unknown as (snapshot: unknown) => void)({})).toThrow("complete registration snapshot");
  withContinuityStorageLock(join(path, "write.lock"), () => {
    expect(() => store.initialize()).toThrow("busy");
  });
  expect(readFileSync(join(path, "threads.json"), "utf8")).toBe(before); expect(() => store.get(thread)).toThrow("not initialized");
  store.initialize(); expect(store.get(thread)!.legacyUnproven).toBe(true);
  expect(JSON.parse(readFileSync(join(path, "initialized.json"), "utf8")).recoveryVersion).toBe(2);
  rmSync(join(path, "recovery.json")); rmSync(join(path, "recovery-initialized.json"));
  expect(() => store.initialize()).toThrow("not reset"); expect(readFileSync(join(path, "threads.json"), "utf8")).toBe(before);
});

test("direct migration blocks real competing claims at every marker and journal write window", () => {
  const { path, registrations } = v1Fixture(); const other = "8".repeat(64);
  const modulePath = join(import.meta.dir, "../src/adapters/chatgpt-web/continuity-registration.ts");
  const source = `import {ContinuityRegistrationStore} from ${JSON.stringify(modulePath)};
    try {new ContinuityRegistrationStore(${JSON.stringify(path)}).claim(${JSON.stringify(other)},${JSON.stringify(scope)},${JSON.stringify(owner.id)}); process.stdout.write('claimed');}
    catch(error){process.stdout.write(String(error).includes('busy')?'blocked':String(error));}`;
  let writes = 0;
  const store = new ContinuityRecoveryStore(path, { beforeWrite: () => {
    writes++;
    expect(() => registrations.claim(other, scope, owner.id)).toThrow("busy");
    const child = spawnSync(process.execPath, ["--eval", source], { encoding: "utf8", timeout: 10_000 });
    expect(child.status).toBe(0); expect(child.stdout).toBe("blocked"); expect(child.stderr).toBe("");
    const marker = JSON.parse(readFileSync(join(path, "initialized.json"), "utf8"));
    expect(marker.recoveryVersion).toBe(writes === 1 ? undefined : 2);
  } });
  store.initialize(); expect(writes).toBe(3); expect(registrations.get(other)).toBeUndefined(); expect(store.get(thread)!.legacyUnproven).toBe(true);
});

for (const failureWindow of [1, 2, 3]) test(`migration failure window ${failureWindow} preserves all registration identity and fails closed after durable intent`, () => {
  const { path, registrations } = v1Fixture(); const before = readFileSync(join(path, "threads.json"), "utf8"); let writes = 0;
  const store = new ContinuityRecoveryStore(path, { beforeWrite: () => { if (++writes === failureWindow) throw new Error("injected migration window failure"); } });
  expect(() => store.initialize()).toThrow(); expect(readFileSync(join(path, "threads.json"), "utf8")).toBe(before);
  expect(registrations.get(thread)!.owner).toBe(owner.id);
  if (failureWindow === 1) {
    registrations.initialize(); expect(new ContinuityRecoveryStore(path).get(thread)!.legacyUnproven).toBe(true);
  } else {
    rmSync(join(path, "recovery.json"), { force: true }); rmSync(join(path, "recovery-initialized.json"), { force: true });
    expect(() => new ContinuityRecoveryStore(path).initialize()).toThrow("not reset");
    expect(() => registrations.initialize()).toThrow("not reset");
    expect(readFileSync(join(path, "threads.json"), "utf8")).toBe(before);
  }
});

test("a claim between wrapper setup and locked migration is included in the complete snapshot", () => {
  const { path, registrations } = v1Fixture(); const other = "8".repeat(64);
  const original = ContinuityRecoveryStore.prototype.initialize;
  const intercepted = spyOn(ContinuityRecoveryStore.prototype, "initialize").mockImplementation(function(this: ContinuityRecoveryStore) {
    registrations.claim(other, scope, owner.id); original.call(this);
  });
  try { registrations.initialize(); } finally { intercepted.mockRestore(); }
  expect(new ContinuityRecoveryStore(path).get(thread)!.legacyUnproven).toBe(true);
  expect(new ContinuityRecoveryStore(path).get(other)!.legacyUnproven).toBe(true);
});

test("first available continuation rejects every existing work alias without changing disk", () => {
  const { path, store } = fixture(); store.admitWork(input()); checkpoint(store);
  const before = readFileSync(join(path, "recovery.json"), "utf8");
  for (const existingId of ["work-A", "compact-A"]) {
    const consumer = input(existingId, { instructionIdentity: "instruction-work-A", createPage: false });
    expect(() => store.consumeContinuation(thread, guard, "commit-A", consumer)).toThrow("new logical work identity");
    expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
    expect(() => store.admitWork({ ...consumer, continuationCommitId: "commit-A" })).toThrow("new logical work identity");
    expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
  }
  const consumer = input("real-consumer", { instructionIdentity: "instruction-work-A", createPage: false });
  const admitted = store.consumeContinuation(thread, guard, "commit-A", consumer);
  expect(admitted.currentWorkId).toBe("real-consumer"); expect(admitted.works["real-consumer"]!.attempts[0]!.historyRevision).toBe(1);
  expect(store.consumeContinuation(thread, guard, "commit-A", consumer).works["real-consumer"]!.attempts).toHaveLength(1);
});

test("optional result bodies and checkpoint reservations share the actual total capacity", () => {
  const { path, store } = fixture(); const retained = new Map<string, Buffer>(); const threads: string[] = [];
  const bodyBytes = 1024 * 1024;
  for (let index = 1; index <= 12; index++) {
    const key = index.toString(16).padStart(64, "0"); threads.push(key);
    store.admitWork(input(`work-${index}`, { thread: key }));
    store.issueBatch(key, guard, { logicalWorkId: `work-${index}`, attempt: 0,
      calls: [{ callId: `call-${index}`, operationId: `operation-${index}`, expectedResultType: "function_call_output" }] });
    store.markDeliveryPossible(key, guard, [`call-${index}`]);
    store.acceptResult(key, guard, { callId: `call-${index}`, resultType: "function_call_output", resultDigest: result });
    expect(store.setResultBodyBytes(key, guard, `call-${index}`, bodyBytes, owner)).toBe(true);
    retained.set(key, Buffer.alloc(bodyBytes));
  }
  let reserved = 0;
  for (let index = 0; index < 8; index++) {
    try { store.registerCompactionTarget(threads[index]!, guard, { sourceLogicalWorkId: `work-${index + 1}`, sourceIdentity: `source-${index}` }); reserved++; }
    catch (error) { expect((error as { code: string }).code).toBe("continuity_resource_capacity"); }
  }
  expect(reserved).toBeLessThan(8);
  const accountedTotal = () => Buffer.byteLength(readFileSync(join(path, "recovery.json"), "utf8")) + retained.size * bodyBytes + reserved * 2 * 1024 * 1024 + 12 * 2048;
  expect(accountedTotal()).toBeLessThanOrEqual(24 * 1024 * 1024);
  // Delete the real optional cache before releasing the charge. Digests remain durable.
  for (let index = 0; index < 5; index++) {
    retained.delete(threads[index]!); store.releaseResultBodyBytes(threads[index]!, guard, [`call-${index + 1}`], owner);
    expect(store.get(threads[index]!)!.calls[`call-${index + 1}`]!.firstResultDigest).toBe(result);
  }
  for (let index = reserved; index < 8; index++) {
    store.registerCompactionTarget(threads[index]!, guard, { sourceLogicalWorkId: `work-${index + 1}`, sourceIdentity: `source-${index}` }); reserved++;
  }
  expect(reserved).toBe(8); expect(accountedTotal()).toBeLessThanOrEqual(24 * 1024 * 1024);
  const disk = readFileSync(join(path, "recovery.json"), "utf8"); expect(disk).not.toContain('"output":');
});

test("optional body rejection preserves real terminal writes, reserves and exact process ownership", () => {
  const { path, store } = fixture(); store.admitWork(input()); batch(store);
  expect(() => store.setResultBodyBytes(thread, guard, "call-A", 1024, owner)).toThrow("real accepted terminal");
  settle(store); const terminal = readFileSync(join(path, "recovery.json"), "utf8");
  expect(store.setResultBodyBytes(thread, guard, "call-A", 2 * 1024 * 1024, owner)).toBe(false);
  expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(terminal);
  expect(store.setResultBodyBytes(thread, guard, "call-A", 1024, owner)).toBe(true);
  const stranger = { ...owner, id: "8".repeat(64) }; const retained = readFileSync(join(path, "recovery.json"), "utf8");
  expect(() => store.releaseResultBodyBytes(thread, guard, ["call-A"], stranger)).toThrow("exact cache owner");
  expect(() => store.setResultBodyBytes(thread, guard, "call-A", 1024, stranger)).toThrow("live or unverified");
  expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(retained);
  store.releaseResultBodyBytes(thread, guard, ["call-A"], owner);
  const dead = { id: "9".repeat(64), pid: 2147483647, startIdentity: "darwin:Mon Jan  1 00:00:00 2024" };
  expect(store.setResultBodyBytes(thread, guard, "call-A", 1024, dead)).toBe(true);
  const released = store.releaseResultBodyBytes(thread, guard, ["call-A"], stranger);
  expect(released.calls["call-A"]!.resultBodyBytes).toBeUndefined(); expect(released.calls["call-A"]!.firstResultDigest).toBe(result);
  expect(store.completeWork(thread, guard, "work-A", { receiptId: "ordinary-final", digest: result }).works["work-A"]!.state).toBe("completed");
});

test("optional body accounting write failure leaves terminal evidence and conservative prior charge", () => {
  let fail = false; const { path, store } = fixture({ beforeWrite: () => { if (fail) throw new Error("injected body accounting failure"); } });
  store.admitWork(input()); batch(store); settle(store); fail = true; let cachePublished = false;
  expect(() => { if (store.setResultBodyBytes(thread, guard, "call-A", 1024, owner)) cachePublished = true; }).toThrow("saved");
  expect(cachePublished).toBe(false); expect(new ContinuityRecoveryStore(path).get(thread)!.calls["call-A"]!.firstResultDigest).toBe(result);
  fail = false; store.setResultBodyBytes(thread, guard, "call-A", 1024, owner); fail = true;
  expect(() => store.releaseResultBodyBytes(thread, guard, ["call-A"], owner)).toThrow("saved");
  expect(new ContinuityRecoveryStore(path).get(thread)!.calls["call-A"]!.resultBodyBytes).toBe(1024);
});

test("Launcher acquisition instance is durable before acquisition and cannot be replaced after Send", () => {
  const { path, store } = fixture(); const admitted = store.admitWork(input());
  const launcher = { pid: owner.pid, startIdentity: owner.startIdentity, instanceId: "8".repeat(64) };
  const other = { ...launcher, instanceId: "9".repeat(64) };
  const possible = store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "page-possible", launcherInstance: launcher });
  expect(possible.transaction!.launcherInstance).toEqual(launcher);
  expect(new ContinuityRecoveryStore(path).get(thread)!.works["work-A"]!.attempts[0]!.launcherInstance).toEqual(launcher);
  expect(() => store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "page-acquired", launcherInstance: other })).toThrow("another Launcher");
  const rebound = store.rebindSnapshot(thread, guard, "work-A", result);
  expect(rebound.transaction!.launcherInstance).toBeUndefined(); expect(rebound.works["work-A"]!.attempts[0]!.launcherInstance).toBeUndefined();
  expect(() => store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "page-acquired", launcherInstance: launcher,
    transactionVersion: admitted.transaction!.version })).toThrow("old transaction");
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "page-possible", launcherInstance: other });
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "send-possible", launcherInstance: other });
  expect(() => store.rebindSnapshot(thread, guard, "work-A", snapshot)).toThrow("sent");
  expect(() => store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "accepted", launcherInstance: launcher })).toThrow("another Launcher");
  store.retireAttempt(thread, guard, "work-A", 0);
  const recovered = store.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot });
  expect(recovered.works["work-A"]!.attempts[0]!.launcherInstance).toEqual(other); expect(recovered.transaction!.launcherInstance).toBeUndefined();
  expect(continuityLauncherInstanceStatus({ ...launcher, startIdentity: "unverified" })).toBe("unverified");
  expect(continuityLauncherInstanceStatus({ ...launcher, pid: 2147483647, startIdentity: "darwin:Mon Jan  1 00:00:00 2024" })).toBe("exited");
});

test("a real child retaining optional result bytes cannot have its live or unknown cache charge stolen", async () => {
  const { path, store } = fixture(); store.admitWork(input()); batch(store); settle(store);
  const modulePath = join(import.meta.dir, "../src/adapters/chatgpt-web/continuity-recovery-store.ts");
  const source = `import {ContinuityRecoveryStore,continuityProcessInstance} from ${JSON.stringify(modulePath)};
    const store=new ContinuityRecoveryStore(${JSON.stringify(path)});const cacheOwner=continuityProcessInstance();const body=Buffer.alloc(1024);
    if(!store.setResultBodyBytes(${JSON.stringify(thread)},${JSON.stringify(guard)},'call-A',body.byteLength,cacheOwner))throw new Error('body reservation rejected');
    process.stdout.write(JSON.stringify(cacheOwner)+'\\n');await new Response(Bun.stdin.stream()).text();process.stdout.write(String(body.byteLength));`;
  const child = Bun.spawn([process.execPath, "--eval", source], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader(); let output = "";
  try {
    while (!output.includes("\n")) { const chunk = await reader.read(); if (chunk.done) throw new Error("child exited before retaining its body"); output += new TextDecoder().decode(chunk.value); }
    const foreign = JSON.parse(output.slice(0, output.indexOf("\n"))) as typeof owner;
    expect(foreign.pid).toBe(child.pid); expect(continuityProcessInstanceStatus(foreign)).not.toBe("exited");
    const before = readFileSync(join(path, "recovery.json"), "utf8");
    store.releaseExitedResultBodies(); expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
    expect(() => store.releaseResultBodyBytes(thread, guard, ["call-A"], owner)).toThrow("exact cache owner");
    expect(() => store.setResultBodyBytes(thread, guard, "call-A", 1024, owner)).toThrow("live or unverified");
    expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before); expect(store.get(thread)!.calls["call-A"]!.firstResultDigest).toBe(result);
    child.stdin.end(); expect(await child.exited).toBe(0); expect(await new Response(child.stderr).text()).toBe("");
    if (foreign.startIdentity === "unverified") {
      expect(() => store.releaseResultBodyBytes(thread, guard, ["call-A"], owner)).toThrow("exact cache owner");
      expect(store.get(thread)!.calls["call-A"]!.resultBodyBytes).toBe(1024);
    } else {
      expect(store.releaseResultBodyBytes(thread, guard, ["call-A"], owner).calls["call-A"]!.resultBodyBytes).toBeUndefined();
    }
  } finally { child.kill(); reader.releaseLock(); await child.exited; }
});

test("shadow source instance proof preserves prepared phase before activation and compiled input binding", () => {
  const { store } = fixture(); store.admitWork(input()); const admitted = shadow(store);
  const launcher = { pid: owner.pid, startIdentity: owner.startIdentity, instanceId: "8".repeat(64) };
  expect(() => store.markAttempt(thread, guard, { logicalWorkId: "compact-A", attempt: 0, stage: "prepared" })).toThrow("replacement page");
  const proof = store.markAttempt(thread, guard, { logicalWorkId: "compact-A", attempt: 0, stage: "prepared", launcherInstance: launcher });
  expect(proof.works["compact-A"]!.attempts[0]!.stage).toBe("prepared"); expect(proof.transaction).toEqual(admitted.transaction);
  expect(proof.works["compact-A"]!.attempts[0]!.launcherInstance).toEqual(launcher); expect(proof.currentWorkId).toBe("work-A");
  store.retireAttempt(thread, guard, "work-A", 0); const activated = store.activateCompaction(thread, guard, "compact-A", activationIdentity(proof));
  expect(activated.transaction!.launcherInstance).toEqual(launcher);
  const compiled = store.rebindSnapshot(thread, guard, "compact-A", result);
  expect(compiled.transaction!.launcherInstance).toBeUndefined(); expect(compiled.transaction!.snapshotDigest).toBe(result);
  expect(compiled.works["compact-A"]!.retryBudget!.attempts).toBe(1);
  store.markAttempt(thread, guard, { logicalWorkId: "compact-A", attempt: 0, stage: "page-possible", launcherInstance: launcher });
  store.markAttempt(thread, guard, { logicalWorkId: "compact-A", attempt: 0, stage: "send-possible", launcherInstance: launcher });
  expect(() => store.rebindSnapshot(thread, guard, "compact-A", snapshot)).toThrow("sent");
});

test("a late shadow callback cannot authorize after append and an accepted handoff commits without a new Send", () => {
  const { store } = fixture(); store.admitWork(input()); shadow(store);
  const launcher = { pid: owner.pid, startIdentity: owner.startIdentity, instanceId: "8".repeat(64) };
  store.markAttempt(thread, guard, { logicalWorkId: "compact-A", attempt: 0, stage: "prepared", launcherInstance: launcher });
  store.admitWork(input("work-B", { predecessorLogicalWorkId: "work-A", createPage: false }));
  const before = store.get(thread)!;
  expect(() => store.markAttempt(thread, guard, { logicalWorkId: "compact-A", attempt: 0, stage: "send-possible", launcherInstance: launcher })).toThrow("current accepted source");
  expect(store.get(thread)).toEqual(before);
  const handoff = fixture().store; handoff.admitWork(input()); const admitted = shadow(handoff);
  handoff.markAttempt(thread, guard, { logicalWorkId: "compact-A", attempt: 0, stage: "prepared", launcherInstance: launcher });
  handoff.markAttempt(thread, guard, { logicalWorkId: "compact-A", attempt: 0, stage: "accepted", launcherInstance: launcher });
  handoff.retireAttempt(thread, guard, "work-A", 0); const activated = handoff.activateCompaction(thread, guard, "compact-A", activationIdentity(admitted));
  handoff.retireAttempt(thread, guard, "compact-A", 0);
  expect(() => handoff.markAttempt(thread, guard, { logicalWorkId: "compact-A", attempt: 0, stage: "page-possible" })).toThrow("late observer");
  const committed = handoff.commitCheckpoint(thread, guard, { logicalWorkId: "compact-A", compactionTargetId: targetId(admitted), commitId: "accepted-handoff", summaryDigest: result, coveredCallIds: [] });
  expect(committed.epoch).toBe(admitted.epoch); expect(committed.works["compact-A"]!.attempts).toHaveLength(1);
  expect(committed.works["compact-A"]!.attempts[0]!.pageReceiptId).toBeUndefined(); expect(activated.transaction!.launcherInstance).toEqual(launcher);
  expect(committed.checkpoints["accepted-handoff"]!.continuation.state).toBe("available");
});

test("rename-before-directory-sync failure retains accepted append facts until exact durability confirmation", () => {
  let fail = false; const { path, store } = fixture({ afterAtomicReplace: () => { if (fail) throw new Error("directory sync receipt lost"); } });
  const original = store.admitWork(input()); fail = true; let reported = false;
  try { store.admitWork(input("work-B", { predecessorLogicalWorkId: "work-A", createPage: false })); reported = true; }
  catch (error) { expect((error as { writeMayHaveCommitted: boolean }).writeMayHaveCommitted).toBe(true); }
  expect(reported).toBe(false);
  const readBack = new ContinuityRecoveryStore(path).get(thread)!;
  expect(readBack.currentWorkId).toBe("work-B"); expect(readBack.works["work-B"]!.instructionIdentity).toBe("instruction-work-B");
  expect(readBack.version).toBe(original.version + 1); expect(readBack.works["work-A"]!.instructionIdentity).toBe("instruction-work-A");
  expect(() => store.confirmDurable(thread, { ...guard, expectedVersion: original.version, expectedEpoch: original.epoch, expectedOwner: owner.id })).toThrow("stale");
  const confirmed = store.confirmDurable(thread, { ...guard, expectedVersion: readBack.version, expectedEpoch: readBack.epoch, expectedOwner: owner.id });
  expect(confirmed).toEqual(readBack); expect(confirmed.version).toBe(readBack.version);
  expect(() => store.reserveRecovery(thread, guard, { logicalWorkId: "work-B", owner, snapshotDigest: snapshot })).toThrow("old lineage writer");
});

test("a pre-rename write rejection cannot create append facts or erase terminal evidence", () => {
  let fail = false; const { path, store } = fixture({ beforeWrite: () => { if (fail) throw new Error("pre-rename failure"); } });
  const original = store.admitWork(input()); batch(store); settle(store); const before = readFileSync(join(path, "recovery.json"), "utf8"); fail = true;
  try { store.admitWork(input("work-B", { predecessorLogicalWorkId: "work-A", createPage: false })); throw new Error("unexpected acceptance"); }
  catch (error) { expect((error as { writeMayHaveCommitted: boolean }).writeMayHaveCommitted).toBe(false); }
  expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
  const current = store.get(thread)!; expect(current.currentWorkId).toBe("work-A"); expect(current.works["work-B"]).toBeUndefined();
  expect(current.calls["call-A"]!.firstResultDigest).toBe(result); expect(current.epoch).toBe(original.epoch);
  expect(store.confirmDurable(thread, { ...guard, expectedVersion: current.version })).toEqual(current);
});

test("same-page append inherits the proved Launcher instance while a new page attempt starts without it", () => {
  const { store } = fixture(); store.admitWork(input());
  const launcher = { pid: owner.pid, startIdentity: owner.startIdentity, instanceId: "8".repeat(64) };
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "page-possible", launcherInstance: launcher });
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "accepted", launcherInstance: launcher });
  const appended = store.admitWork(input("work-B", { predecessorLogicalWorkId: "work-A", createPage: false }));
  expect(appended.works["work-B"]!.attempts[0]!.launcherInstance).toEqual(launcher); expect(appended.transaction!.launcherInstance).toEqual(launcher);
  store.retireAttempt(thread, guard, "work-A", 0); store.retireAttempt(thread, guard, "work-B", 0);
  const recovered = store.reserveRecovery(thread, guard, { logicalWorkId: "work-B", owner, snapshotDigest: result });
  expect(recovered.works["work-B"]!.attempts[1]!.launcherInstance).toBeUndefined(); expect(recovered.transaction!.launcherInstance).toBeUndefined();
});

test("installation-wide memory reclamation removes only exited cache charges and preserves terminal identities", () => {
  const { path, store } = fixture(); const otherThread = "8".repeat(64);
  const dead = { id: "9".repeat(64), pid: 2147483647, startIdentity: "darwin:Mon Jan  1 00:00:00 2024" };
  store.admitWork(input()); batch(store); settle(store); store.setResultBodyBytes(thread, guard, "call-A", 1024, dead);
  store.admitWork(input("live-work", { thread: otherThread }));
  store.issueBatch(otherThread, guard, { logicalWorkId: "live-work", attempt: 0, calls: [{ callId: "live-call", operationId: "live-op", expectedResultType: "function_call_output" }] });
  store.markDeliveryPossible(otherThread, guard, ["live-call"]);
  store.acceptResult(otherThread, guard, { callId: "live-call", resultType: "function_call_output", resultDigest: result });
  store.setResultBodyBytes(otherThread, guard, "live-call", 1024, { ...owner, startIdentity: "unverified" });
  const oldExited = store.get(thread)!; const live = store.get(otherThread)!; store.releaseExitedResultBodies();
  const reclaimed = store.get(thread)!;
  expect(reclaimed.version).toBe(oldExited.version + 1); expect(reclaimed.calls["call-A"]!.resultBodyBytes).toBeUndefined();
  expect(reclaimed.calls["call-A"]!.firstResultDigest).toBe(result); expect(reclaimed.works).toEqual(oldExited.works);
  expect(reclaimed.lineages).toEqual(oldExited.lineages); expect(store.get(otherThread)).toEqual(live);
  const before = readFileSync(join(path, "recovery.json"), "utf8"); store.releaseExitedResultBodies(); expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
});

test("preparation reservation retains both full tags and fences every new execution before host coordination", () => {
  const { path, store, launcherInstance } = preparedMigrationFixture();
  const registered = store.registerCompactionTarget(thread, guard, { sourceLogicalWorkId: "work-A", sourceIdentity: "source-A" }); const target = targetId(registered);
  const old = store.get(thread)!;
  const pending = store.beginPreparation(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: result, launcherInstance });
  const migration = pending.pendingPreparation!;
  expect(pending.owner).toEqual(old.owner); expect(pending.transaction!).toEqual(old.transaction!); expect(pending.works).toEqual(old.works);
  expect(migration.expected).toEqual({ owner: old.owner, transaction: old.transaction! });
  expect(migration.target.owner).toEqual(owner); expect(migration.target.transaction.version).toBe(old.transaction!.version + 1);
  expect(migration.target.transaction.snapshotVersion).toBe(old.transaction!.snapshotVersion + 1);
  expect(migration.target.transaction.snapshotDigest).toBe(result); expect(migration.target.transaction.pageReceiptId).toBeUndefined();
  expect(migration.target.transaction.launcherInstance).toEqual(launcherInstance);
  const before = readFileSync(join(path, "recovery.json"), "utf8");
  for (const action of [
    () => store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "send-possible" }),
    () => store.issueBatch(thread, guard, { logicalWorkId: "work-A", attempt: 0, calls: [{ callId: "call-A", operationId: "op-A", expectedResultType: "function_call_output" }] }),
    () => store.rebindSnapshot(thread, guard, "work-A", snapshot),
    () => store.retireAttempt(thread, guard, "work-A", 0),
    () => store.reserveRecovery(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot }),
    () => store.admitWork(input("work-B", { predecessorLogicalWorkId: "work-A", createPage: false })),
    () => store.registerCompactionTarget(thread, guard, { sourceLogicalWorkId: "work-A", sourceIdentity: "source-A" }),
    () => store.admitWork(input("compact-A", { purpose: "compaction", compactionTargetId: target, createPage: false })),
    () => store.activateCompaction(thread, guard, "compact-A", { attempt: 0, snapshotVersion: 0, transactionId: "0".repeat(64), transactionVersion: 0 }),
    () => store.completeWork(thread, guard, "work-A", { receiptId: "fake-final", digest: result }),
  ]) { expect(action).toThrow("preparation"); expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before); }
  expect(() => store.transact(thread, guard, record => { record.owner = owner; })).toThrow("authorization");
  expect(() => store.transact(thread, guard, record => { record.pendingPreparation!.target.transaction.snapshotDigest = snapshot; })).toThrow("authorization");
  const confirmed = store.completePreparation(thread, { ...guard, expectedVersion: pending.version }, migration.preparationId);
  expect(confirmed.pendingPreparation).toBeUndefined(); expect(confirmed.owner).toEqual(owner);
  expect(confirmed.transaction).toEqual(migration.target.transaction); expect(confirmed.works["work-A"]!.attempts).toHaveLength(1);
  expect(confirmed.works["work-A"]!.retryBudget).toEqual(old.works["work-A"]!.retryBudget);
  const saved = readFileSync(join(path, "recovery.json"), "utf8");
  expect(store.completePreparation(thread, guard, migration.preparationId)).toEqual(confirmed); expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(saved);
  expect(() => store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "send-possible", transactionVersion: old.transaction!.version })).toThrow("old transaction");
});

test("preparation survives both write failure windows and a lost completion receipt", () => {
  let beforeFailure = false, afterFailure = false;
  const { path, store, launcherInstance } = preparedMigrationFixture({ beforeWrite: () => { if (beforeFailure) throw new Error("before rename"); },
    afterAtomicReplace: () => { if (afterFailure) throw new Error("after rename"); } });
  const proposed = { logicalWorkId: "work-A", owner, snapshotDigest: result, launcherInstance };
  const old = store.get(thread)!; beforeFailure = true;
  expect(() => store.beginPreparation(thread, guard, proposed)).toThrow("saved"); expect(store.get(thread)).toEqual(old);
  beforeFailure = false; afterFailure = true;
  expect(() => store.beginPreparation(thread, guard, proposed)).toThrow("saved");
  let reopened = new ContinuityRecoveryStore(path); const reserved = reopened.get(thread)!; const id = reserved.pendingPreparation!.preparationId;
  expect(reserved.owner).toEqual(old.owner); expect(reserved.transaction!).toEqual(old.transaction!);
  expect(reopened.beginPreparation(thread, guard, proposed).pendingPreparation!.preparationId).toBe(id);
  afterFailure = false; beforeFailure = true;
  expect(() => store.completePreparation(thread, guard, id)).toThrow("saved"); expect(reopened.get(thread)!.pendingPreparation!.preparationId).toBe(id);
  beforeFailure = false; afterFailure = true;
  expect(() => store.completePreparation(thread, guard, id)).toThrow("saved");
  reopened = new ContinuityRecoveryStore(path); const committed = reopened.get(thread)!;
  expect(committed.pendingPreparation).toBeUndefined(); expect(committed.preparationReceipt!.preparationId).toBe(id);
  expect(committed.owner).toEqual(owner); expect(reopened.completePreparation(thread, guard, id)).toEqual(committed);
  expect(committed.works["work-A"]!.attempts).toHaveLength(1); expect(committed.works["work-A"]!.retryBudget!.attempts).toBe(1);
});

test("a second exited backend must complete the original migration before reserving another", () => {
  const { path, store, launcherInstance } = preparedMigrationFixture();
  const nextOwner = { id: "9".repeat(64), pid: 2147483646, startIdentity: "darwin:Mon Jan  1 00:00:00 2024" };
  const first = store.beginPreparation(thread, guard, { logicalWorkId: "work-A", owner: nextOwner, snapshotDigest: result, launcherInstance });
  const before = readFileSync(join(path, "recovery.json"), "utf8");
  const reopened = new ContinuityRecoveryStore(path);
  expect(() => reopened.beginPreparation(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot, launcherInstance })).toThrow("previous preparation");
  expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
  const intermediate = reopened.completePreparation(thread, guard, first.pendingPreparation!.preparationId);
  const second = reopened.beginPreparation(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot, launcherInstance });
  expect(second.pendingPreparation!.expected.owner).toEqual(nextOwner); expect(second.pendingPreparation!.expected.transaction).toEqual(intermediate.transaction!);
  expect(second.pendingPreparation!.target.transaction.snapshotVersion).toBe(2);
  const finished = reopened.completePreparation(thread, guard, second.pendingPreparation!.preparationId);
  expect(finished.transaction!.snapshotVersion).toBe(2); expect(finished.transaction!.version).toBe(2); expect(finished.epoch).toBe(first.epoch);
  expect(finished.works["work-A"]!.attempts).toHaveLength(1); expect(finished.works["work-A"]!.retryBudget!.attempts).toBe(1);
  expect(() => reopened.completePreparation(thread, guard, first.pendingPreparation!.preparationId)).toThrow("completion receipt");
  const sameOwner = reopened.beginPreparation(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: result, launcherInstance });
  expect(sameOwner.pendingPreparation!.expected.owner).toEqual(owner);
});

test("stop retains pending identities until exact physical retirement and then permits one independent new work", () => {
  const { path, store, launcherInstance } = preparedMigrationFixture();
  const reserved = store.beginPreparation(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: result, launcherInstance }); const migration = reserved.pendingPreparation!;
  expect(() => store.retirePreparation(thread, guard, migration.preparationId)).toThrow("explicitly stopped");
  const stopped = store.stopWork(thread, guard, "work-A", "native-interrupt");
  expect(stopped.pendingPreparation).toEqual(migration); expect(stopped.works["work-A"]!.state).toBe("stopped");
  expect(() => store.completePreparation(thread, guard, migration.preparationId)).toThrow("stopped");
  expect(() => store.admitWork(input("work-C"))).toThrow("preparation");
  const retired = new ContinuityRecoveryStore(path).retirePreparation(thread, guard, migration.preparationId);
  expect(retired.pendingPreparation).toBeUndefined(); expect(retired.retiredPreparation).toEqual(migration);
  expect(retired.works).toEqual(stopped.works); expect(retired.owner).toEqual(stopped.owner); expect(retired.transaction).toEqual(stopped.transaction);
  expect(() => store.completePreparation(thread, guard, migration.preparationId)).toThrow("completion receipt");
  const fresh = store.admitWork(input("work-C")); expect(fresh.epoch).toBe(1); expect(fresh.works["work-A"]!.state).toBe("stopped");
  expect(store.admitWork(input("work-C")).epoch).toBe(1);
});

test("preparation tags reject plaintext, conflicting Launcher identity and possibly sent snapshots", () => {
  const { path, store, launcherInstance } = preparedMigrationFixture();
  const before = readFileSync(join(path, "recovery.json"), "utf8");
  expect(() => store.beginPreparation(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: result, launcherInstance: { ...launcherInstance, instanceId: "9".repeat(64) } })).toThrow("exact current unsent");
  expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
  const pending = store.beginPreparation(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: result, launcherInstance });
  expect(() => store.transact(thread, guard, record => { (record.pendingPreparation!.target.transaction as unknown as Record<string, unknown>).prompt = "SECRET_PENDING_INPUT"; })).toThrow("schema");
  expect(readFileSync(join(path, "recovery.json"), "utf8")).not.toContain("SECRET_PENDING_INPUT");
  store.completePreparation(thread, guard, pending.pendingPreparation!.preparationId);
  store.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "send-possible" });
  expect(() => store.beginPreparation(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: snapshot, launcherInstance })).toThrow("unsent");
});

test("pending preparation metadata shares both item and total capacity before any host RPC", () => {
  for (const itemLimit of [false, true]) {
    const { path, store, launcherInstance } = preparedMigrationFixture(); const before = readFileSync(join(path, "recovery.json"), "utf8");
    const record = store.get(thread)!;
    const limits = itemLimit ? { itemBytes: Buffer.byteLength(JSON.stringify({ work: record.works["work-A"], calls: [] })) + 2048 + 200 }
      : { totalBytes: Buffer.byteLength(before) + 2048 + 200 };
    const bounded = new ContinuityRecoveryStore(path, { limits }); let hostCalls = 0;
    expect(() => { bounded.beginPreparation(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: result, launcherInstance }); hostCalls++; }).toThrow("capacity");
    expect(hostCalls).toBe(0); expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before); expect(bounded.get(thread)!.owner).toEqual(record.owner);
  }
});

test("a full pending preparation account still admits a real first result and durable stop without granting Send", () => {
  const { path, store, launcherInstance } = preparedMigrationFixture(); const otherThread = "9".repeat(64);
  store.admitWork(input("other-work", { thread: otherThread }));
  store.issueBatch(otherThread, guard, { logicalWorkId: "other-work", attempt: 0,
    calls: [{ callId: "other-call", operationId: "other-operation", expectedResultType: "function_call_output" }] });
  store.markDeliveryPossible(otherThread, guard, ["other-call"]);
  const pending = store.beginPreparation(thread, guard, { logicalWorkId: "work-A", owner, snapshotDigest: result, launcherInstance });
  const migration = pending.pendingPreparation!;
  const fullBytes = Buffer.byteLength(readFileSync(join(path, "recovery.json"), "utf8")) + 2 * 2048 + 256;
  const bounded = new ContinuityRecoveryStore(path, { limits: { totalBytes: fullBytes } });
  const settled = bounded.acceptResult(otherThread, guard, { callId: "other-call", resultType: "function_call_output", resultDigest: result });
  expect(settled.calls["other-call"]!.state).toBe("settled"); expect(settled.calls["other-call"]!.firstResultDigest).toBe(result);
  expect(bounded.get(thread)!.pendingPreparation).toEqual(migration);
  const stopped = bounded.stopWork(thread, guard, "work-A", "user-stop"); expect(stopped.works["work-A"]!.state).toBe("stopped");
  expect(stopped.pendingPreparation).toEqual(migration); expect(stopped.transaction!.snapshotDigest).toBe(snapshot);
  const before = readFileSync(join(path, "recovery.json"), "utf8");
  expect(() => bounded.completePreparation(thread, guard, migration.preparationId)).toThrow("stopped");
  expect(() => bounded.markAttempt(thread, guard, { logicalWorkId: "work-A", attempt: 0, stage: "send-possible" })).toThrow("preparation");
  expect(readFileSync(join(path, "recovery.json"), "utf8")).toBe(before);
});
