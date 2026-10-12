import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityRecoveryStore, continuityProcessInstance, type AdmitRecoveryWorkInput } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { bindRecoveryContextCoverage, reserveRecoveryContextCoverage, releaseRecoveryContextCoverageReservation, restoreRecoveryContextCoverage, recordRecoveryAppend, recordRecoveryDelivery, type RuntimeRecoveryReference } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { CompactionSourceCoverage, captureCompactionSource } from "../src/adapters/chatgpt-web/compaction-context";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { parseRequest } from "../src/responses/parser";
import { validateContextCoverageMetadata, type ContextCoverageJournalEntry } from "../src/adapters/chatgpt-web/context-coverage-journal";

const roots: string[] = [];
const thread = "1".repeat(64), scope = "2".repeat(64), digest = "3".repeat(64);
const owner = continuityProcessInstance("4".repeat(64));
const parsed = () => parseRequest({ model: "gpt-5.6-sol", input: "private source body never belongs in the journal" });
const plan = (planId = "plan-A") => ({ historyRevision: 0, pageGeneration: "page-A", planId,
  bodyDigest: digest, manifestDigest: digest, pageTokens: 100, externalizedTargetIds: [] });
function input(logicalWorkId = "work-A", extra: Partial<AdmitRecoveryWorkInput> = {}): AdmitRecoveryWorkInput {
  return { thread, scope, owner, logicalWorkId, instructionIdentity: `instruction-${logicalWorkId}`,
    nativeTurnId: "turn-A", workPayloadDigest: digest, snapshotDigest: digest, createPage: true,
    dispatchProtocolComplete: true, ...extra };
}
function fixture(options: ConstructorParameters<typeof ContinuityRecoveryStore>[1] = {}) {
  const directory = mkdtempSync(join(tmpdir(), "context-coverage-journal-")); roots.push(directory);
  new ContinuityRegistrationStore(directory).initialize();
  const store = new ContinuityRecoveryStore(directory, options); store.admitWork(input());
  const ref: RuntimeRecoveryReference = { directory, thread, logicalWorkId: "work-A", attempt: 0, ownerId: owner.id };
  return { directory, store, ref };
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("each selected-plan mutation persists digest evidence and restart cannot restore sources from it", () => {
  const { directory, store, ref } = fixture(); const coverage = new CompactionSourceCoverage();
  bindRecoveryContextCoverage(ref, coverage);
  const source = createContextSnapshot(parsed()); coverage.prepare(source, plan());
  expect(new ContinuityRecoveryStore(directory).get(thread)!.contextCoverage![0]!.metadata.delivered).toBe(false);
  coverage.markDelivered("plan-A");
  coverage.recordTaskUpdate(createContextSnapshot(parseRequest({ model: "gpt-5.6-sol", input: "accepted extra instruction" })));
  const entry = store.get(thread)!.contextCoverage![0]!;
  expect(entry).toMatchObject({ ownerId: owner.id, logicalWorkId: "work-A", attempt: 0, epoch: 0, acceptedTaskRevision: 1 });
  expect(entry.metadata.acceptedUpdates).toHaveLength(1);
  const encoded = readFileSync(join(directory, "recovery.json"), "utf8");
  expect(encoded).not.toContain("private source body"); expect(encoded).not.toContain("accepted extra instruction");
  expect(encoded).not.toContain(source.context_id); expect(encoded).not.toContain(source.targets[0]!.read_ref!);
  expect(() => bindRecoveryContextCoverage(ref, new CompactionSourceCoverage())).toThrow("not independently restored");
  expect(() => captureCompactionSource(parsed(), new CompactionSourceCoverage())).toThrow("no accepted source coverage");
});

test("journal enforces exact digest schema and owner, revision, retirement, and monotone evidence", () => {
  const { store, ref } = fixture(); const coverage = new CompactionSourceCoverage(); bindRecoveryContextCoverage(ref, coverage);
  coverage.prepare(createContextSnapshot(parsed()), plan()); coverage.markDelivered("plan-A");
  const before = store.get(thread)!;
  for (const mutate of [
    (entry: ContextCoverageJournalEntry) => { entry.metadata.delivered = false; },
    (entry: ContextCoverageJournalEntry) => { entry.ownerId = "5".repeat(64); },
    (entry: ContextCoverageJournalEntry) => { entry.metadata.historyRevision = 1; },
    (entry: ContextCoverageJournalEntry) => { entry.metadata.versions = []; },
  ]) expect(() => store.transact(thread, { scope }, draft => mutate(draft.contextCoverage![0]!))).toThrow();
  expect(() => store.transact(thread, { scope }, draft => { draft.contextCoverage = []; })).toThrow("cannot be removed");
  expect(() => validateContextCoverageMetadata({ ...coverage.latest()!, body: "forbidden raw source" })).toThrow("schema");
  expect(() => bindRecoveryContextCoverage({ ...ref, ownerId: "5".repeat(64) }, coverage)).toThrow("obsolete owner");
  expect(store.get(thread)).toEqual(before);
  store.retireAttempt(thread, { scope }, "work-A", 0);
  expect(() => coverage.prepare(createContextSnapshot(parsed()), plan("plan-B"))).toThrow("obsolete execution");
  expect(coverage.metadata()).toHaveLength(1);
});

test("selected context format survives restart and cannot change after source preparation", () => {
  const { directory, store, ref } = fixture();
  const coverage = new CompactionSourceCoverage();
  bindRecoveryContextCoverage(ref, coverage);
  const source = createContextSnapshot(parsed());
  coverage.prepare(source, { ...plan(), contextFormat: "codex-context-text-v1" });
  expect(coverage.latest()?.contextFormat).toBe("codex-context-text-v1");
  expect(() => coverage.prepare(source, { ...plan(), contextFormat: "legacy-json" })).toThrow("changed after preparation");
  coverage.markDelivered("plan-A");
  const saved = new ContinuityRecoveryStore(directory).get(thread)!.contextCoverage![0]!.metadata;
  expect(saved.contextFormat).toBe("codex-context-text-v1");
  expect(() => validateContextCoverageMetadata({ ...saved, contextFormat: "unknown-format" })).toThrow("schema");
  expect(() => store.transact(thread, { scope }, draft => { draft.contextCoverage![0]!.metadata.contextFormat = "legacy-json"; })).toThrow();
  expect(() => store.transact(thread, { scope }, draft => { delete draft.contextCoverage![0]!.metadata.contextFormat; })).toThrow();
  const { contextFormat: _format, ...historical } = saved;
  expect(() => validateContextCoverageMetadata(historical)).not.toThrow();
  const restored = CompactionSourceCoverage.restoreVerifiedSource(source, [saved], 0);
  expect(restored.latest()?.contextFormat).toBe("codex-context-text-v1");
});

for (const limit of ["itemBytes", "totalBytes"] as const) test(`journal ${limit} failure retains both durable and in-memory pending evidence`, () => {
  const { store } = fixture({ limits: { [limit]: 6_000 } });
  const coverage = new CompactionSourceCoverage();
  coverage.bindPersistence(metadata => {
    if (!metadata.length) return;
    store.transact(thread, { scope }, draft => {
      draft.contextCoverage = metadata.map(value => ({ ownerId: owner.id, logicalWorkId: "work-A", workLineageId: "work-A",
        attempt: 0, epoch: draft.epoch, acceptedTaskRevision: 1, sourceTaskRevision: 1, metadata: structuredClone(value) }));
    });
  });
  coverage.prepare(createContextSnapshot(parsed()), plan()); const before = store.get(thread)!;
  const large = parseRequest({ model: "gpt-5.6-sol", input: Array.from({ length: 90 }, (_, i) => ({ role: "user", content: `source ${i}` })) });
  expect(() => coverage.prepare(createContextSnapshot(large), plan("plan-B"))).toThrow("capacity");
  expect(store.get(thread)).toEqual(before); expect(coverage.metadata()).toHaveLength(1);
  expect(coverage.latest()!.delivered).toBe(false);
});

test("append commits prepared coverage with the instruction revision and rejects invalid coverage before acceptance", () => {
  const { store, ref } = fixture(); const coverage = new CompactionSourceCoverage(); bindRecoveryContextCoverage(ref, coverage);
  coverage.prepare(createContextSnapshot(parsed()), plan()); coverage.markDelivered("plan-A");
  const prepared = coverage.fork(); prepared.recordTaskUpdate(createContextSnapshot(parsed()));
  const append = { logicalWorkId: "work-B", instructionIdentity: "instruction-B", nativeTurnId: "turn-B", workPayloadDigest: digest,
    snapshotDigest: digest, localSessionId: "session", localTaskRevision: 1, results: [], contextCoverage: prepared.metadata() };
  const before = store.get(thread)!;
  const oversized = prepared.metadata().map(value => ({ ...value, acceptedUpdates: [Array(35_000).fill(digest)] }));
  expect(() => recordRecoveryAppend(ref, { ...append, contextCoverage: oversized })).toThrow("capacity");
  expect(store.get(thread)).toEqual(before); expect(ref.logicalWorkId).toBe("work-A");
  expect(() => recordRecoveryAppend(ref, { ...append, contextCoverage: [] })).toThrow("not independently restored");
  expect(store.get(thread)).toEqual(before); expect(ref.logicalWorkId).toBe("work-A");
  recordRecoveryAppend(ref, append);
  const committed = store.get(thread)!;
  expect(committed.currentWorkId).toBe("work-B"); expect(committed.contextCoverage![0]!.sourceTaskRevision).toBe(2);
  expect(committed.contextCoverage![0]!.metadata.acceptedUpdates).toHaveLength(1);
  coverage.acceptPreparedCoverage(prepared);
  expect(store.get(thread)!.version).toBe(committed.version);
});

test("only a successful checkpoint clears covered records; failed checkpoint leaves them intact", () => {
  const { store, ref } = fixture(); const coverage = new CompactionSourceCoverage(); bindRecoveryContextCoverage(ref, coverage);
  coverage.prepare(createContextSnapshot(parsed()), plan()); coverage.markDelivered("plan-A");
  const registered = store.registerCompactionTarget(thread, { scope }, { sourceLogicalWorkId: "work-A", sourceIdentity: "source-A" });
  const target = Object.keys(registered.compactionTargets)[0]!;
  store.retireAttempt(thread, { scope }, "work-A", 0);
  store.admitWork(input("compact-A", { purpose: "compaction", compactionTargetId: target, createPage: false }));
  const commit = { logicalWorkId: "compact-A", commitId: "commit-A", compactionTargetId: target, summaryDigest: digest, coveredCallIds: [] };
  expect(() => store.commitCheckpoint(thread, { scope }, commit)).toThrow("physical writer settlement");
  expect(store.get(thread)!.contextCoverage).toHaveLength(1);
  store.retireAttempt(thread, { scope }, "compact-A", 0);
  store.commitCheckpoint(thread, { scope }, commit);
  expect(store.get(thread)!.contextCoverage).toEqual([]);
  coverage.checkpointCommitted(0); expect(coverage.metadata()).toEqual([]);
});

test("manual candidate capacity is reserved before publication and consumed only by the selected candidate", () => {
  const { directory, store, ref } = fixture(); const coverage = new CompactionSourceCoverage(); bindRecoveryContextCoverage(ref, coverage);
  const source = createContextSnapshot(parsed());
  const full = coverage.fork(); full.prepare(source, plan("full"));
  const resume = coverage.fork(); resume.prepare(source, plan("resume"));
  const oversized = full.metadata().map(value => ({ ...value, versions: Array(35_000).fill(digest) }));
  const before = store.get(thread)!;
  expect(() => reserveRecoveryContextCoverage(ref, [oversized])).toThrow("capacity");
  expect(store.get(thread)).toEqual(before);
  reserveRecoveryContextCoverage(ref, [full.metadata(), resume.metadata()]);
  const reserved = new ContinuityRecoveryStore(directory).get(thread)!;
  expect(reserved.contextCoverage).toBeUndefined(); expect(reserved.contextCoverageReservations).toHaveLength(1);
  reserveRecoveryContextCoverage(ref, [full.metadata(), resume.metadata()]);
  expect(store.get(thread)!.version).toBe(reserved.version);
  expect(() => coverage.prepare(source, plan("unreserved"))).toThrow("reserved candidate");
  expect(coverage.metadata()).toEqual([]); expect(store.get(thread)).toEqual(reserved);
  coverage.prepare(source, plan("resume"));
  const selected = store.get(thread)!;
  expect(selected.contextCoverageReservations).toEqual([]);
  expect(selected.contextCoverage!.map(entry => entry.metadata.planId)).toEqual(["resume"]);
  expect(selected.contextCoverage![0]!.metadata.delivered).toBe(false);
  expect(() => coverage.prepare(source, plan("unknown-send-replacement"))).toThrow("unresolved selected source Send");
  coverage.markDelivered("resume");
  expect(store.get(thread)!.contextCoverage![0]!.metadata.delivered).toBe(true);
});

test("an uncertain coverage write cannot publish memory and exact retry confirms durability", () => {
  const { directory, store, ref } = fixture(); const coverage = new CompactionSourceCoverage(); bindRecoveryContextCoverage(ref, coverage);
  const original = ContinuityRecoveryStore.prototype.transact;
  const failing = new ContinuityRecoveryStore(directory, { afterAtomicReplace: () => { throw new Error("sync interrupted"); } });
  const write = spyOn(ContinuityRecoveryStore.prototype, "transact").mockImplementation(function (thread, guard, mutate) {
    return original.call(failing, thread, guard, mutate);
  });
  try {
    expect(() => coverage.prepare(createContextSnapshot(parsed()), plan())).toThrow("could not be confirmed");
    expect(coverage.metadata()).toEqual([]);
  } finally { write.mockRestore(); }
  expect(store.get(thread)!.contextCoverage).toHaveLength(1);
  const confirm = spyOn(ContinuityRecoveryStore.prototype, "confirmDurable");
  try {
    coverage.prepare(createContextSnapshot(parsed()), plan());
    expect(confirm).toHaveBeenCalledTimes(1); expect(coverage.metadata()).toHaveLength(1);
  } finally { confirm.mockRestore(); }
});

test("a known-unpublished capacity rejection releases only its reservation and permits a new candidate retry", () => {
  const { store, ref } = fixture(); const coverage = new CompactionSourceCoverage(); bindRecoveryContextCoverage(ref, coverage);
  const source = createContextSnapshot(parsed()); coverage.prepare(source, plan("previous-source")); coverage.markDelivered("previous-source");
  const first = coverage.fork(); first.prepare(source, plan("first-manual-candidate"));
  reserveRecoveryContextCoverage(ref, [first.metadata()]);
  const before = store.get(thread)!;
  const retry = coverage.fork(); retry.prepare(source, plan("new-manual-candidate"));
  expect(() => reserveRecoveryContextCoverage(ref, [retry.metadata()])).toThrow("cannot be rebound");
  expect(() => store.transact(thread, { scope }, draft => { draft.contextCoverageReservations = []; })).toThrow("exact reserved selected candidate");
  expect(() => releaseRecoveryContextCoverageReservation({ ...ref, ownerId: "5".repeat(64) })).toThrow("obsolete execution");
  expect(store.get(thread)).toEqual(before);
  // The caller has an explicit Launcher capacity rejection before lease or publication.
  releaseRecoveryContextCoverageReservation(ref);
  expect(store.get(thread)!.contextCoverage).toEqual(before.contextCoverage);
  expect(store.get(thread)!.contextCoverageReservations).toEqual([]);
  reserveRecoveryContextCoverage(ref, [retry.metadata()]);
  coverage.acceptPreparedCoverage(retry);
  expect(store.get(thread)!.contextCoverage!.map(entry => entry.metadata.planId)).toEqual(["previous-source", "new-manual-candidate"]);
});

test("a remote append rebinds only to its exact committed coverage and current writer", () => {
  const { store, ref } = fixture(); const coverage = new CompactionSourceCoverage(); bindRecoveryContextCoverage(ref, coverage);
  coverage.prepare(createContextSnapshot(parsed()), plan()); coverage.markDelivered("plan-A");
  const prepared = coverage.fork(); prepared.recordTaskUpdate(createContextSnapshot(parsed()));
  const brokerRef = { ...ref };
  recordRecoveryAppend(brokerRef, { logicalWorkId: "work-B", instructionIdentity: "instruction-B", nativeTurnId: "turn-B",
    workPayloadDigest: digest, snapshotDigest: digest, localSessionId: "session", localTaskRevision: 1,
    results: [], contextCoverage: prepared.metadata() });
  expect(ref.logicalWorkId).toBe("work-A"); expect(brokerRef.logicalWorkId).toBe("work-B");
  expect(() => bindRecoveryContextCoverage(ref, coverage, prepared.metadata())).toThrow("obsolete execution");
  expect(() => bindRecoveryContextCoverage(brokerRef, coverage, coverage.metadata())).toThrow("exact already committed");
  bindRecoveryContextCoverage(brokerRef, coverage, prepared.metadata());
  coverage.acceptPreparedCoverage(prepared);
  coverage.recordTaskUpdate(createContextSnapshot(parsed()));
  expect(store.get(thread)!.contextCoverage![0]!.metadata.acceptedUpdates).toHaveLength(2);
});

test("verified actual sources restore the digest ledger under a new writer without changing old origin evidence", () => {
  const { store, ref } = fixture(); const coverage = new CompactionSourceCoverage(); bindRecoveryContextCoverage(ref, coverage);
  const original = createContextSnapshot(parsed()); coverage.prepare(original, plan()); coverage.markDelivered("plan-A");
  const before = store.get(thread)!.contextCoverage![0]!;
  store.retireAttempt(thread, { scope }, "work-A", 0);
  const nextOwner = continuityProcessInstance("6".repeat(64));
  store.reserveRecovery(thread, { scope }, { logicalWorkId: "work-A", owner: nextOwner, snapshotDigest: digest });
  const nextRef = { ...ref, attempt: 1, ownerId: nextOwner.id };
  expect(() => restoreRecoveryContextCoverage(nextRef, createContextSnapshot(parseRequest({ model: "gpt-5.6-sol", input: "changed source" })))).toThrow("missing or changed");
  const actual = createContextSnapshot(parsed());
  const restored = restoreRecoveryContextCoverage(nextRef, actual)!;
  expect(actual.context_id).not.toBe(original.context_id); expect(restored.metadata()).toEqual(coverage.metadata());
  bindRecoveryContextCoverage(nextRef, restored);
  restored.prepare(actual, { ...plan("recovered-plan"), pageGeneration: "replacement-page" });
  restored.markDelivered("recovered-plan");
  expect(store.get(thread)!.contextCoverage![0]).toEqual(before);
  expect(store.get(thread)!.contextCoverage![1]).toMatchObject({ ownerId: nextOwner.id, attempt: 1, epoch: 1 });
});

test("a stopped lineage remains durable while a new independent lineage owns only its own source coverage", () => {
  const { store, ref } = fixture(); const old = new CompactionSourceCoverage(); bindRecoveryContextCoverage(ref, old);
  old.prepare(createContextSnapshot(parsed()), plan()); old.markDelivered("plan-A");
  const oldEntry = store.get(thread)!.contextCoverage![0]!;
  store.stopWork(thread, { scope }, "work-A", "user-stop");
  store.admitWork(input("work-C", { nativeTurnId: "turn-C" }));
  const nextRef = { ...ref, logicalWorkId: "work-C" }; const current = new CompactionSourceCoverage();
  bindRecoveryContextCoverage(nextRef, current);
  const changedOld = old.fork(); changedOld.recordTaskUpdate(createContextSnapshot(parsed()));
  expect(() => bindRecoveryContextCoverage(nextRef, changedOld)).toThrow("another instruction lineage");
  const source = createContextSnapshot(parseRequest({ model: "gpt-5.6-sol", input: "independent new source" }));
  const candidate = current.fork(); candidate.prepare(source, plan("plan-C"));
  reserveRecoveryContextCoverage(nextRef, [candidate.metadata()]); current.acceptPreparedCoverage(candidate); current.markDelivered("plan-C");
  const entries = store.get(thread)!.contextCoverage!;
  expect(entries.find(entry => entry.workLineageId === "work-A")).toEqual(oldEntry);
  expect(entries.filter(entry => entry.workLineageId === "work-C")).toHaveLength(1);
  expect(current.metadata().map(value => value.planId)).toEqual(["plan-C"]);
});

test("ordinary same-page history echoes preserve their original lineage while a new selected plan uses the current writer", () => {
  const { store, ref } = fixture(); const first = new CompactionSourceCoverage(); bindRecoveryContextCoverage(ref, first);
  const source = createContextSnapshot(parsed()); first.prepare(source, plan()); first.markDelivered("plan-A");
  store.completeWork(thread, { scope }, "work-A", { receiptId: "final-A", digest });
  const original = store.get(thread)!.contextCoverage![0]!;
  store.admitWork(input("work-B", { nativeTurnId: "turn-B", createPage: false }));
  const nextRef = { ...ref, logicalWorkId: "work-B" }; const second = first.fork();
  bindRecoveryContextCoverage(nextRef, second);
  const candidate = second.fork(); candidate.prepare(source, plan("plan-B"));
  reserveRecoveryContextCoverage(nextRef, [candidate.metadata()]); second.acceptPreparedCoverage(candidate); second.markDelivered("plan-B");
  const entries = store.get(thread)!.contextCoverage!;
  expect(entries[0]).toEqual(original);
  expect(entries[1]).toMatchObject({ logicalWorkId: "work-B", workLineageId: "work-B", ownerId: owner.id });
  expect(second.metadata().map(value => value.planId)).toEqual(["plan-A", "plan-B"]);
});

test("navigation usage is durable, monotone and cannot reuse reserved tokens to reduce previously charged page cost", () => {
  const { directory, store, ref } = fixture(); const coverage = new CompactionSourceCoverage(); bindRecoveryContextCoverage(ref, coverage);
  coverage.prepare(createContextSnapshot(parsed()), { ...plan(), navigationReservedTokens: 60 }); coverage.markDelivered("plan-A");
  coverage.recordNavigationUsage("plan-A", { tokens: 100, wireBytes: 400, reservedTokensUsed: 0 });
  coverage.recordNavigationUsage("plan-A", { tokens: 110, wireBytes: 420, reservedTokensUsed: 60 });
  const before = new ContinuityRecoveryStore(directory).get(thread)!;
  expect(before.contextCoverage![0]!.metadata).toMatchObject({ pageTokens: 200, navigationReservedTokens: 60,
    navigationUsage: { tokens: 110, wireBytes: 420, reservedTokensUsed: 60, chargedTokens: 100 } });
  const beforeMemory = coverage.metadata();
  expect(() => coverage.recordNavigationUsage("plan-A", { tokens: 111, wireBytes: 440, reservedTokensUsed: 61 })).toThrow();
  expect(coverage.metadata()).toEqual(beforeMemory); expect(store.get(thread)).toEqual(before);
  for (const field of ["tokens", "wireBytes", "reservedTokensUsed", "chargedTokens"] as const) {
    expect(() => store.transact(thread, { scope }, draft => { draft.contextCoverage![0]!.metadata.navigationUsage![field]--; })).toThrow();
  }
  expect(() => store.transact(thread, { scope }, draft => { draft.contextCoverage![0]!.metadata.navigationReservedTokens = 61; })).toThrow();
  expect(() => store.transact(thread, { scope }, draft => { delete draft.contextCoverage![0]!.metadata.navigationUsage; })).toThrow();
  expect(() => store.transact(thread, { scope }, draft => { draft.contextCoverage![0]!.metadata.navigationUsage!.chargedTokens++; })).toThrow();
  expect(() => validateContextCoverageMetadata({ ...beforeMemory[0]!, navigationUsage: { ...beforeMemory[0]!.navigationUsage!, rawResponse: "forbidden" } })).toThrow();
  expect(store.get(thread)).toEqual(before);
  coverage.recordNavigationUsage("plan-A", { tokens: 180, wireBytes: 600, reservedTokensUsed: 60 });
  expect(store.get(thread)!.contextCoverage![0]!.metadata).toMatchObject({ pageTokens: 220,
    navigationUsage: { tokens: 180, wireBytes: 600, reservedTokensUsed: 60, chargedTokens: 120 } });
});

for (const terminal of ["completed", "retired", "stopped"] as const) test(`empty delivery after ${terminal} is read-only while a nonempty batch remains fenced`, () => {
  const { directory, store, ref } = fixture();
  if (terminal === "completed") store.completeWork(thread, { scope }, "work-A", { receiptId: "final-A", digest });
  else if (terminal === "retired") store.retireAttempt(thread, { scope }, "work-A", 0);
  else store.stopWork(thread, { scope }, "work-A", "user-stop");
  const before = readFileSync(join(directory, "recovery.json"), "utf8");
  expect(() => recordRecoveryDelivery(ref, [])).not.toThrow();
  expect(readFileSync(join(directory, "recovery.json"), "utf8")).toBe(before);
  expect(() => recordRecoveryDelivery(ref, [{ callId: "late-call", wireName: "exec_command", freeform: false,
    arguments: { cmd: "must-not-dispatch" } }])).toThrow();
  expect(readFileSync(join(directory, "recovery.json"), "utf8")).toBe(before);
  expect(store.get(thread)!.calls["late-call"]).toBeUndefined();
});
