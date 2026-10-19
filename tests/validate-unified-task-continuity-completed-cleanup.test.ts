import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupCompletedContinuityPage, completedCleanupDisposition, type CompletedCleanupSource } from "../scripts/unified-task-continuity-completed-cleanup";
import { ContinuityRecoveryStore, continuityProcessInstance, type RecoveryThreadRecord } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { recoveryIdentity } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import type { ContinuityLease, ContinuityTransactionReceipt } from "../src/adapters/chatgpt-web/continuity-contract";

// Real local durable admission/dispatch/result/final APIs. Only Launcher/CDP
// observations are controlled; no fixture is a live page or installed DEV proof.
function fixture(completed = true, purpose: "ordinary" | "compaction" = "ordinary") {
  const directory = mkdtempSync(join(tmpdir(), "continuity-cleanup-test-"));
  new ContinuityRegistrationStore(directory).initialize();
  const store = new ContinuityRecoveryStore(directory), owner = continuityProcessInstance();
  const thread = "1".repeat(64), scope = "2".repeat(64);
  const launcherInstance = { pid: owner.pid, startIdentity: owner.startIdentity, instanceId: "3".repeat(64) };
  store.admitWork({ thread, scope, owner, logicalWorkId: "work", instructionIdentity: "instruction", workPayloadDigest: "4".repeat(64), snapshotDigest: "5".repeat(64), dispatchProtocolComplete: true });
  store.markAttempt(thread, { scope }, { logicalWorkId: "work", attempt: 0, stage: "accepted", launcherInstance });
  store.issueBatch(thread, { scope }, { logicalWorkId: "work", attempt: 0, calls: [{ callId: "actual-fixture-call", operationId: "actual-fixture-operation", expectedResultType: "function_call_output" }] });
  store.markDeliveryPossible(thread, { scope }, ["actual-fixture-call"]);
  store.acceptResult(thread, { scope }, { callId: "actual-fixture-call", resultType: "function_call_output", resultDigest: "6".repeat(64) });
  let currentWork = "work";
  if (purpose === "compaction") {
    const targeted = store.registerCompactionTarget(thread, { scope }, { sourceLogicalWorkId: "work", sourceIdentity: "fixture-source", representationDigests: ["a".repeat(64)] });
    const target = Object.values(targeted.compactionTargets)[0]!;
    store.retireAttempt(thread, { scope }, "work", 0);
    currentWork = "compaction-work";
    store.admitWork({ thread, scope, owner, logicalWorkId: currentWork, instructionIdentity: "compact", workPayloadDigest: "b".repeat(64), snapshotDigest: "c".repeat(64),
      purpose: "compaction", compactionTargetId: target.compactionTargetId, dispatchProtocolComplete: true });
    store.markAttempt(thread, { scope }, { logicalWorkId: currentWork, attempt: 0, stage: "accepted", launcherInstance });
    store.retireAttempt(thread, { scope }, currentWork, 0);
    if (completed) store.commitCheckpoint(thread, { scope }, { logicalWorkId: currentWork, compactionTargetId: target.compactionTargetId, commitId: "fixture-commit",
      summaryDigest: "7".repeat(64), coveredCallIds: ["actual-fixture-call"], retainedBodyBytes: 0 });
  } else if (completed) store.completeWork(thread, { scope }, "work", { receiptId: "actual-fixture-final", digest: "7".repeat(64) });
  const ref = { directory, thread, logicalWorkId: currentWork, attempt: 0, ownerId: owner.id };
  let observed: RecoveryThreadRecord | undefined = store.get(thread)!, instance = structuredClone(launcherInstance);
  const identity = recoveryIdentity(observed!, store.installationId());
  const lease: ContinuityLease = { owner: "fixture-owner", leaseId: "fixture-lease", traceId: "fixture-trace", recovery: identity };
  const counts = { settlement: 0, query: 0, inspect: 0, release: 0, targets: 0 };
  // Match the actual onContinuityLease capture: ownership plus its original
  // settlement Promise. Additional callbacks are runtime data, not ownership.
  const workerPage = { lease, conversation: "8".repeat(64), settlement: Promise.resolve(),
    onObservation: () => { throw new Error("unrelated worker callback must not run"); } };
  let physical: ContinuityTransactionReceipt["physicalCleanup"] = "pending";
  const source: CompletedCleanupSource = {
    ref, installationId: store.installationId(), readRecord: () => structuredClone(observed),
    registrationPresent: () => Boolean(JSON.parse(readFileSync(join(directory, "threads.json"), "utf8")).entries?.[thread]),
    owned: workerPage, ownedTargets: new Set(["owned-old-target"]),
    expectedResults: [{ callId: "actual-fixture-call", firstResultDigest: "6".repeat(64) }],
    originalLauncher: { pid: launcherInstance.pid, launcherInstance, surfaceTargets: { home: "home-target" } },
    currentLauncher: () => ({ pid: instance.pid, launcherInstance: instance, surfaceTargets: { home: "home-target", "owned-surface": "owned-current-target" } }),
    physicalSettlement: async () => { counts.settlement++; await workerPage.settlement; },
    query: async exact => { counts.query++; expect(exact).toEqual(identity); return { recovery: exact, state: "completed", writerRetired: true,
      executionProtocol: 1, executionIsolated: true, toolsSettled: false, hostNoWriter: true, launcherInstance,
      continuity: structuredClone(lease), tabId: "owned-tab", surfaceId: "owned-surface", physicalCleanup: physical }; },
    inspect: async (conversation, expected) => { counts.inspect++; expect(conversation).toBe(source.owned!.conversation); expect(expected).toEqual(lease); return { continuity: lease, state: "ready" }; },
    release: async (conversation, expected, timeoutMs) => { counts.release++; expect(conversation).toBe(source.owned!.conversation); expect(expected).toEqual(lease); expect(timeoutMs).toBeGreaterThan(0); physical = "destroyed"; store.removePage(thread, store.get(thread)!); observed = undefined; return 1; },
    targetsAbsent: async targets => { counts.targets++; expect([...targets].sort()).toEqual(["owned-current-target", "owned-old-target"]); return true; },
  };
  const path = join(directory, "recovery.json"), original = readFileSync(path);
  return { source, counts, directory, path, original, store, thread, scope, lease, workerPage,
    mutate: (change: (record: RecoveryThreadRecord) => void) => { change(observed!); },
    changeInstance: () => { instance = { ...instance, instanceId: "9".repeat(64) }; },
    setPhysical: (state: typeof physical) => { physical = state; },
    dispose: () => rmSync(directory, { recursive: true, force: true }) };
}
const limits = { deadlineMs: 1000, settlementMs: 100, pollMs: 1 };

test("exact completed page release removes page tasks and observes physical absence", async () => {
  const f = fixture();
  try {
    const result = await cleanupCompletedContinuityPage(f.source, limits);
    expect(result).toMatchObject({ attempted: true, released: true, physicalSettlementConfirmed: true, cleanupConfirmed: true, journalUnchanged: false, pageTaskRemoved: true, registryEntryRemoved: true });
    expect(result.error).toBeUndefined(); expect(f.counts.release).toBe(1); expect(f.counts.targets).toBe(1);
    expect(f.store.get(f.thread)).toBeUndefined();
    expect(completedCleanupDisposition("passed", result)).toEqual({ status: "passed", keepPrivateRuntime: false });
  } finally { f.dispose(); }
});

test("completed standalone compaction releases its page and removes the source and checkpoint task records", async () => {
  const f = fixture(true, "compaction");
  try {
    const before = f.store.get(f.thread)!;
    expect(before.works.work!.state).not.toBe("completed");
    expect(before.works["compaction-work"]!.state).toBe("completed");
    expect(before.works["compaction-work"]!.attempts[0]!.stage).toBe("interrupted-settled");
    expect(Object.keys(before.checkpoints)).toHaveLength(1);
    const result = await cleanupCompletedContinuityPage(f.source, limits);
    expect(result).toMatchObject({ cleanupConfirmed: true, journalUnchanged: false, pageTaskRemoved: true, registryEntryRemoved: true }); expect(f.counts.release).toBe(1);
    expect(f.store.get(f.thread)).toBeUndefined();
  } finally { f.dispose(); }
});

test("completed compaction cannot clean a page when the exact committed summary proof is missing or changed", async () => {
  for (const kind of ["missing", "changed"] as const) {
    const f = fixture(true, "compaction");
    try {
      f.mutate(record => { if (kind === "missing") delete record.checkpoints["fixture-commit"]; else record.checkpoints["fixture-commit"]!.summaryDigest = "f".repeat(64); });
      const result = await cleanupCompletedContinuityPage(f.source, limits);
      expect(result.error).toContain("exact checkpoint"); expect(f.counts.release).toBe(0); expect(f.counts.settlement).toBe(0);
      expect(readFileSync(f.path)).toEqual(f.original);
    } finally { f.dispose(); }
  }
});

test.each(["active", "stopped", "prepared", "send-possible", "missing"])("%s work never waits on settlement or starts page release", async state => {
  const f = fixture(false);
  try {
    f.mutate(record => { if (state === "missing") delete record.works.work; else record.works.work!.state = state as typeof record.works.work.state; });
    f.source.physicalSettlement = () => { throw new Error("must not wait"); };
    const result = await cleanupCompletedContinuityPage(f.source, limits);
    expect(result).toMatchObject({ attempted: false, released: false, cleanupConfirmed: false });
    expect(f.counts.query).toBe(0); expect(f.counts.release).toBe(0);
    expect(readFileSync(f.path)).toEqual(f.original);
  } finally { f.dispose(); }
});

test.each(["lease", "current-work", "current-attempt", "terminal", "result", "result-digest", "ACK"])("invalid %s evidence refuses cleanup before settlement", async kind => {
  const f = fixture();
  try {
    if (kind === "lease") f.source.owned!.lease = { ...f.lease, recovery: { ...f.lease.recovery!, snapshotVersion: 99 } };
    else f.mutate(record => {
      if (kind === "current-work") record.currentWorkId = "another";
      if (kind === "current-attempt") record.works.work!.attempts[0]!.attempt = 1;
      if (kind === "terminal") delete record.works.work!.terminalReceiptId;
      if (kind === "result") record.calls["actual-fixture-call"]!.state = "delivery-possible";
      if (kind === "result-digest") record.calls["actual-fixture-call"]!.firstResultDigest = "a".repeat(64);
      if (kind === "ACK") record.works.work!.taskUpdateJournal = { streamId: "fixture-stream", acceptedRevision: 1, acknowledgedRevision: 0, driverGeneration: 0, updates: [], deliveries: [] };
    });
    const result = await cleanupCompletedContinuityPage(f.source, limits);
    expect(result.error).toBeDefined(); expect(result.cleanupConfirmed).toBe(false);
    expect(f.counts.settlement).toBe(0); expect(f.counts.release).toBe(0);
    expect(readFileSync(f.path)).toEqual(f.original);
  } finally { f.dispose(); }
});

test("settlement timeout prevents all later release even when the original promise resolves late", async () => {
  const f = fixture(); let resolve!: () => void;
  try {
    f.workerPage.settlement = new Promise<void>(done => { resolve = done; });
    const result = await cleanupCompletedContinuityPage(f.source, { ...limits, settlementMs: 10 });
    expect(result.error).toContain("not confirmed before deadline"); expect(result.physicalSettlementConfirmed).toBe(false);
    expect(f.counts.query).toBe(0); expect(f.counts.release).toBe(0);
    resolve(); await Bun.sleep(10); expect(f.counts.release).toBe(0); expect(f.counts.query).toBe(0);
    expect(completedCleanupDisposition("passed", result)).toEqual({ status: "failed", keepPrivateRuntime: true });
  } finally { f.dispose(); }
});

test.each(["journal", "instance"])("%s change during the original settlement wait prevents release", async kind => {
  const f = fixture();
  try {
    f.source.physicalSettlement = async () => { if (kind === "journal") f.mutate(record => { record.version++; }); else f.changeInstance(); };
    const result = await cleanupCompletedContinuityPage(f.source, limits);
    expect(result.error).toContain(kind === "journal" ? "journal changed" : "instance changed");
    expect(f.counts.release).toBe(0); expect(result.cleanupConfirmed).toBe(false);
  } finally { f.dispose(); }
});

test("a query timeout cannot start a late release when the original read-only query eventually resolves", async () => {
  const f = fixture(); let finish!: () => void;
  try {
    const query = f.source.query;
    f.source.query = identity => new Promise(done => { finish = () => { void query(identity).then(done); }; });
    const result = await cleanupCompletedContinuityPage(f.source, { ...limits, deadlineMs: 15 });
    expect(result.error).toContain("not confirmed before deadline"); expect(f.counts.release).toBe(0);
    finish(); await Bun.sleep(10); expect(f.counts.release).toBe(0); expect(f.counts.inspect).toBe(0);
  } finally { f.dispose(); }
});

test.each(["journal", "instance"])("%s change during exact query prevents release", async kind => {
  const f = fixture();
  try {
    const query = f.source.query;
    f.source.query = async identity => { const value = await query(identity); if (kind === "journal") f.mutate(record => { record.version++; }); else f.changeInstance(); return value; };
    const result = await cleanupCompletedContinuityPage(f.source, limits);
    expect(result.error).toBeDefined(); expect(f.counts.release).toBe(0); expect(result.cleanupConfirmed).toBe(false);
  } finally { f.dispose(); }
});

test.each(["obsolete", "wrong-lease", "not-ready", "baseline-target"])("%s Launcher observation never authorizes release", async kind => {
  const f = fixture();
  try {
    const query = f.source.query;
    f.source.query = async identity => {
      const result = await query(identity);
      if (kind === "obsolete") result.recovery = { ...identity, transactionVersion: identity.transactionVersion + 1 };
      if (kind === "wrong-lease") result.continuity = { ...f.lease, leaseId: "another-lease" };
      if (kind === "baseline-target") result.surfaceId = "home";
      return result;
    };
    if (kind === "not-ready") f.source.inspect = async () => ({ continuity: f.lease, state: "running" });
    const result = await cleanupCompletedContinuityPage(f.source, limits);
    expect(result.error).toBeDefined(); expect(result.cleanupConfirmed).toBe(false); expect(f.counts.release).toBe(0);
  } finally { f.dispose(); }
});

test("delayed physical absence is observed after one exact release without requiring a completed tombstone", async () => {
  const f = fixture();
  try {
    const targetsAbsent = f.source.targetsAbsent;
    f.source.targetsAbsent = async targets => { const absent = await targetsAbsent(targets, 100); return absent && f.counts.targets > 3; };
    // Real durable writes can exceed one second on Windows.
    const result = await cleanupCompletedContinuityPage(f.source, { ...limits, deadlineMs: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.cleanupConfirmed).toBe(true); expect(f.counts.targets).toBeGreaterThan(3); expect(f.counts.release).toBe(1);
    expect(f.counts.query).toBe(1); expect(f.store.get(f.thread)).toBeUndefined();
  } finally { f.dispose(); }
});

test("instance change after release refuses confirmation without another release", async () => {
  const f = fixture();
  try {
    const release = f.source.release;
    f.source.release = async (...args) => { const value = await release(...args); f.changeInstance(); return value; };
    const result = await cleanupCompletedContinuityPage(f.source, limits);
    expect(result.error).toContain("instance changed"); expect(result.cleanupConfirmed).toBe(false); expect(f.counts.release).toBe(1);
  } finally { f.dispose(); }
});

test.each(["release-error", "release-timeout", "destroy-failed", "target-present"])("%s keeps facts and never repeats release after timeout or error", async kind => {
  const f = fixture(); let lateRelease: (() => void) | undefined;
  try {
    if (kind === "release-error") f.source.release = async () => { f.counts.release++; throw new Error("labelled release error"); };
    if (kind === "release-timeout") f.source.release = () => { f.counts.release++; return new Promise(done => { lateRelease = () => done(1); }); };
    if (kind === "destroy-failed") f.source.release = async () => { f.counts.release++; f.setPhysical("failed"); return 1; };
    if (kind === "target-present") f.source.targetsAbsent = async () => false;
    const result = await cleanupCompletedContinuityPage(f.source, { ...limits, deadlineMs: ["release-timeout", "destroy-failed", "target-present"].includes(kind) ? 30 : 1000 });
    expect(result.cleanupConfirmed).toBe(false); expect(result.error).toBeDefined(); expect(f.counts.release).toBe(1);
    const queryCount = f.counts.query; lateRelease?.(); await Bun.sleep(10);
    expect(f.counts.release).toBe(1); expect(f.counts.query).toBe(queryCount);
    if (kind === "target-present") expect(f.store.get(f.thread)).toBeUndefined();
    else expect(readFileSync(f.path)).toEqual(f.original);
  } finally { f.dispose(); }
});

test("an earlier oracle failure retains the failed verdict after successful page task removal", async () => {
  const f = fixture();
  try {
    const result = await cleanupCompletedContinuityPage(f.source, limits);
    const disposition = completedCleanupDisposition("failed", result);
    expect(result.cleanupConfirmed).toBe(true); expect(f.counts.release).toBe(1);
    expect(disposition).toEqual({ status: "failed", keepPrivateRuntime: true });
    expect(existsSync(f.path)).toBe(true); expect(f.store.get(f.thread)).toBeUndefined();
    expect(completedCleanupDisposition("passed", result, true)).toEqual({ status: "failed", keepPrivateRuntime: true });
  } finally { f.dispose(); }
});

test("real runtime capture with its original settlement Promise and callback cleans only the exact ownership projection", async () => {
  const f = fixture();
  try {
    const result = await cleanupCompletedContinuityPage(f.source, limits);
    expect(result).toMatchObject({ attempted: true, released: true, physicalSettlementConfirmed: true, cleanupConfirmed: true, journalUnchanged: false, pageTaskRemoved: true, registryEntryRemoved: true });
    expect(result.error).toBeUndefined(); expect(f.counts.settlement).toBe(1); expect(f.counts.query).toBe(1);
    expect(f.counts.inspect).toBe(1); expect(f.counts.release).toBe(1); expect(f.counts.targets).toBe(1);
    expect(f.store.get(f.thread)).toBeUndefined();
    expect(completedCleanupDisposition("failed", result)).toEqual({ status: "failed", keepPrivateRuntime: true });
  } finally { f.dispose(); }
});

test("the captured pending settlement must resolve before any exact query or release", async () => {
  const f = fixture(); let resolve!: () => void;
  try {
    f.workerPage.settlement = new Promise<void>(done => { resolve = done; });
    const running = cleanupCompletedContinuityPage(f.source, limits);
    await Bun.sleep(0);
    expect(f.counts.settlement).toBe(1); expect(f.counts.query).toBe(0); expect(f.counts.inspect).toBe(0); expect(f.counts.release).toBe(0);
    resolve();
    const result = await running;
    expect(result.cleanupConfirmed).toBe(true); expect(result.physicalSettlementConfirmed).toBe(true);
    expect(f.counts.query).toBe(1); expect(f.counts.release).toBe(1);
    expect(f.store.get(f.thread)).toBeUndefined();
  } finally { f.dispose(); }
});

test("the captured rejected settlement never starts exact query or release and retains the original facts", async () => {
  const f = fixture(); let reject!: (error: Error) => void;
  try {
    f.workerPage.settlement = new Promise<void>((_done, fail) => { reject = fail; });
    const running = cleanupCompletedContinuityPage(f.source, limits);
    expect(f.counts.settlement).toBe(1);
    reject(new Error("original settlement rejected"));
    const result = await running;
    expect(result.error).toBe("original settlement rejected"); expect(result.physicalSettlementConfirmed).toBe(false);
    expect(result.cleanupConfirmed).toBe(false); expect(f.counts.query).toBe(0); expect(f.counts.inspect).toBe(0); expect(f.counts.release).toBe(0);
    expect(completedCleanupDisposition("passed", result)).toEqual({ status: "failed", keepPrivateRuntime: true });
    expect(completedCleanupDisposition("failed", result)).toEqual({ status: "failed", keepPrivateRuntime: true });
    expect(readFileSync(f.path)).toEqual(f.original);
  } finally { f.dispose(); }
});

for (const retained of ["journal", "registration"]) test(`physical absence cannot hide a retained ${retained}`, async () => {
  const f = fixture();
  try {
    if (retained === "journal") f.source.release = async () => { f.counts.release++; return 1; };
    else f.source.registrationPresent = () => true;
    const result = await cleanupCompletedContinuityPage(f.source, { ...limits, deadlineMs: 30 });
    expect(result.cleanupConfirmed).toBe(false); expect(result.error).toBeDefined(); expect(f.counts.release).toBe(1);
  } finally { f.dispose(); }
});
