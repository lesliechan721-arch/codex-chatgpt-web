import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { recoveryIdentity, type RuntimeRecoveryReference } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import type { RecoveryThreadRecord } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import type { ContinuityLauncherInstance, ContinuityLease, ContinuityRecoveryIdentity, ContinuityTransactionReceipt } from "../src/adapters/chatgpt-web/continuity-contract";

type LauncherIdentity = { pid: number; launcherInstance?: ContinuityLauncherInstance; surfaceTargets: Record<string, string> };
export interface CompletedCleanupSource {
  ref: RuntimeRecoveryReference;
  installationId: string;
  readRecord(): RecoveryThreadRecord | undefined;
  registrationPresent(): boolean;
  owned?: { lease: ContinuityLease; conversation: string };
  originalLauncher: LauncherIdentity;
  ownedTargets: Set<string>;
  expectedResults: ReadonlyArray<{ callId: string; firstResultDigest: string }>;
  physicalSettlement(): Promise<void>;
  currentLauncher(): LauncherIdentity;
  query(identity: ContinuityRecoveryIdentity): Promise<ContinuityTransactionReceipt>;
  inspect(conversation: string, lease: ContinuityLease): Promise<{ continuity: ContinuityLease; state: "ready" | "running" }>;
  release(conversation: string, lease: ContinuityLease, timeoutMs: number): Promise<number>;
  targetsAbsent(targets: ReadonlySet<string>, timeoutMs: number): Promise<boolean>;
}
export interface CompletedCleanupResult {
  attempted: boolean; released: boolean; physicalSettlementConfirmed: boolean; cleanupConfirmed: boolean;
  journalUnchanged: boolean; pageTaskRemoved?: boolean; registryEntryRemoved?: boolean; reason?: string; error?: string;
}
export const COMPLETED_CLEANUP_DEADLINE_MS = 30_000;
export const COMPLETED_SETTLEMENT_DEADLINE_MS = 15_000;

/** Timeouts stop this decision flow, never cancel a turn or authorize new effects. */
export async function boundedCleanupObservation<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, `${label}: cleanup deadline expired`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: cleanup not confirmed before deadline`)), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Caller supplies the original production interfaces; local tests execute this same decision flow. */
export async function cleanupCompletedContinuityPage(source: CompletedCleanupSource, limits = {
  deadlineMs: COMPLETED_CLEANUP_DEADLINE_MS, settlementMs: COMPLETED_SETTLEMENT_DEADLINE_MS, pollMs: 100,
}): Promise<CompletedCleanupResult> {
  const result: CompletedCleanupResult = { attempted: false, released: false, physicalSettlementConfirmed: false, cleanupConfirmed: false, journalUnchanged: false };
  const end = Date.now() + limits.deadlineMs;
  const remaining = () => { const value = end - Date.now(); assert.ok(value > 0, "cleanup overall deadline expired"); return value; };
  const observe = <T>(operation: () => Promise<T>, label: string) => {
    const budget = remaining(); return boundedCleanupObservation(operation(), budget, label);
  };
  try {
    assert.ok(limits.deadlineMs > 0 && limits.deadlineMs <= COMPLETED_CLEANUP_DEADLINE_MS
      && limits.settlementMs > 0 && limits.settlementMs <= COMPLETED_SETTLEMENT_DEADLINE_MS
      && limits.pollMs > 0 && limits.pollMs <= 100, "invalid cleanup limits");
    const record = structuredClone(source.readRecord()), work = record?.works[source.ref.logicalWorkId];
    // Incomplete, stopped and unknown tasks must not even start waiting on physical settlement.
    if (!record || work?.state !== "completed") { result.reason = "work not completed; no wait or release"; return result; }
    result.attempted = true;
    assert.equal(record.thread, source.ref.thread);
    if (source.ref.ownerId) assert.equal(record.owner.id, source.ref.ownerId, "completed owner changed");
    assert.equal(record.currentWorkId, source.ref.logicalWorkId, "completed work is not current");
    assert.ok(work.terminalReceiptId && work.terminalDigest, "completed work lacks terminal evidence");
    const attempt = work.attempts.at(-1)!;
    // commitRecoveryCompaction retires its physical writer before commitCheckpoint;
    // the immutable attempt can remain interrupted-settled after the exact commit.
    const checkpoint = work.purpose === "compaction" ? record.checkpoints[work.terminalReceiptId] : undefined;
    const committedCompaction = Boolean(checkpoint && checkpoint.compactionTargetId === work.compactionTargetId
      && checkpoint.summaryDigest === work.terminalDigest && checkpoint.workLineageId === work.workLineageId);
    assert.ok(work.purpose !== "compaction" || committedCompaction, "completed compaction lacks its exact checkpoint");
    assert.ok((attempt?.stage === "completed" || committedCompaction && attempt?.stage === "interrupted-settled")
      && attempt.writerRetired && attempt.dispatchProtocolComplete && attempt.attempt === source.ref.attempt, "latest attempt not completed or not exact");
    assert.ok(Object.values(record.calls).every(call => call.state === "settled" && call.firstResultDigest), "tool results remain unsettled");
    assert.ok(source.expectedResults.every(result => record.calls[result.callId]?.firstResultDigest === result.firstResultDigest), "original fixture result digest changed or missing");
    assert.ok(!work.taskUpdateJournal || work.taskUpdateJournal.acceptedRevision === work.taskUpdateJournal.acknowledgedRevision, "task ACK remains pending");
    // Only the ownership contract is cloneable. A runtime capture can also carry
    // its original settlement Promise, which remains in physicalSettlement().
    const owned = source.owned ? { lease: structuredClone(source.owned.lease), conversation: source.owned.conversation } : undefined;
    assert.ok(owned?.lease.recovery && /^[a-f0-9]{64}$/.test(owned.conversation), "completed page lacks original lease/conversation");
    const identity = recoveryIdentity(record, source.installationId);
    assert.ok(isDeepStrictEqual(owned.lease.recovery, identity), "completed lease is not current durable identity");
    assert.equal(identity.attempt, source.ref.attempt);
    assert.equal(identity.logicalWorkId, source.ref.logicalWorkId);
    assert.ok(identity.launcherInstance && source.originalLauncher.launcherInstance, "Launcher instance evidence missing");
    assert.ok(isDeepStrictEqual(identity.launcherInstance, source.originalLauncher.launcherInstance), "original Launcher instance mismatch");
    const unchanged = () => {
      remaining();
      assert.ok(isDeepStrictEqual(source.readRecord(), record), "completed journal changed during cleanup");
      const current = source.currentLauncher();
      assert.equal(current.pid, source.originalLauncher.pid, "Launcher PID changed during cleanup");
      assert.ok(isDeepStrictEqual(current.launcherInstance, source.originalLauncher.launcherInstance), "Launcher instance changed during cleanup");
      return current;
    };
    unchanged();
    await boundedCleanupObservation(source.physicalSettlement(), Math.min(remaining(), limits.settlementMs), "completed physical settlement");
    result.physicalSettlementConfirmed = true; unchanged();
    const validateReceipt = (receipt: ContinuityTransactionReceipt) => {
      assert.ok(isDeepStrictEqual(receipt.recovery, identity), "cleanup returned an obsolete transaction");
      assert.equal(receipt.state, "completed", "cleanup transaction is no longer completed");
      assert.ok(isDeepStrictEqual(receipt.launcherInstance, source.originalLauncher.launcherInstance), "receipt Launcher instance mismatch");
    };
    const receipt = await observe(() => source.query(identity), "completed query"); validateReceipt(receipt); unchanged();
    if (receipt.physicalCleanup !== "destroyed") {
      assert.ok(isDeepStrictEqual(receipt.continuity, owned.lease), "query does not own original lease");
      assert.ok(receipt.surfaceId && receipt.tabId, "query lacks exact physical page");
      const inspected = await observe(() => source.inspect(owned.conversation, owned.lease), "completed inspection");
      assert.equal(inspected.state, "ready"); assert.ok(isDeepStrictEqual(inspected.continuity, owned.lease), "inspection does not own original lease");
      const current = unchanged(), target = current.surfaceTargets[receipt.surfaceId];
      assert.ok(target && !(receipt.surfaceId in source.originalLauncher.surfaceTargets), "target is not case-owned");
      source.ownedTargets.add(target);
      const released = await observe(() => source.release(owned.conversation, owned.lease, Math.min(15_000, remaining())), "completed release");
      assert.ok(Number.isSafeInteger(released) && released >= 0, "invalid release receipt");
      result.released = released > 0;
    }
    assert.ok(source.ownedTargets.size > 0, "case has no exact physical target observation");
    // A destroyed page has no retained completed transaction. Observe the exact
    // targets and both task stores, without requiring a historical tombstone.
    for (;;) {
      remaining();
      const current = source.currentLauncher();
      assert.equal(current.pid, source.originalLauncher.pid, "Launcher PID changed during cleanup");
      assert.ok(isDeepStrictEqual(current.launcherInstance, source.originalLauncher.launcherInstance), "Launcher instance changed during cleanup");
      const currentRecord = source.readRecord();
      assert.ok(!currentRecord || isDeepStrictEqual(currentRecord, record), "completed journal changed during cleanup");
      const absent = await observe(() => source.targetsAbsent(source.ownedTargets, remaining()), "exact target absence");
      if (absent && !source.readRecord() && !source.registrationPresent()) break;
      await observe(() => Bun.sleep(Math.min(limits.pollMs, remaining())), "page task cleanup wait");
    }
    result.cleanupConfirmed = true; result.pageTaskRemoved = true; result.registryEntryRemoved = true;
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  return result;
}

/** Successful physical cleanup cannot turn an earlier oracle failure into success. */
export function completedCleanupDisposition(oracleStatus: string, result: CompletedCleanupResult, otherCleanupError = false) {
  const status = oracleStatus === "passed" && (!result.cleanupConfirmed || result.error || otherCleanupError) ? "failed" : oracleStatus;
  return { status, keepPrivateRuntime: status !== "passed" || !result.cleanupConfirmed || otherCleanupError };
}
