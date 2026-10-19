import { afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityRecoveryStore, continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { continuityDigest, continuitySourceRepresentationDigest, recoveryContinuationPrimaryIndices } from "../src/adapters/chatgpt-web/continuity-source";
import { requestCarriedChatGptInstructionRevision } from "../src/adapters/chatgpt-web/environment-instruction";
import { selectRecoveryContinuation, type RecoveryContinuationRecord } from "../src/adapters/chatgpt-web/continuity-recovery-continuation";
import { measureRuntimeOperation } from "../src/runtime-performance";
import { performanceTest } from "./helpers/performance-test";
import {
  checkpointSourceDecision, checkpointSourceIdentity, checkpointSourceItem, checkpointSourceMarker, checkpointSourceRequest,
  checkpointSourceScope, checkpointSourceSummary, checkpointSourceThread, checkpointSourceView, changedCheckpointSource,
} from "./helpers/checkpoint-source-fixture";

const test = performanceTest(import.meta.path);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function committedSource(original: Record<string, unknown>) {
  return measureRuntimeOperation("fixture.prepare", () => {
    const directory = mkdtempSync(join(tmpdir(), "checkpoint-source-contract-")); roots.push(directory);
    new ContinuityRegistrationStore(directory).initialize();
    const store = new ContinuityRecoveryStore(directory), owner = continuityProcessInstance();
    const parsed = checkpointSourceRequest([original]);
    const carried = requestCarriedChatGptInstructionRevision(parsed, checkpointSourceIdentity.turnId)!;
    const common = { thread: checkpointSourceThread, scope: checkpointSourceScope, owner, nativeTurnId: checkpointSourceIdentity.turnId,
      createPage: true, dispatchProtocolComplete: true };
    store.admitWork({ ...common, logicalWorkId: "source", instructionIdentity: carried.itemId!,
      workPayloadDigest: continuityDigest("source-payload"), snapshotDigest: continuityDigest("source-snapshot") });
    store.retireAttempt(checkpointSourceThread, { scope: checkpointSourceScope }, "source", 0);
    const record = store.registerCompactionTarget(checkpointSourceThread, { scope: checkpointSourceScope }, { sourceLogicalWorkId: "source",
      sourceIdentity: carried.itemId!, representationDigests: [continuitySourceRepresentationDigest(parsed, carried)] });
    const target = Object.values(record.compactionTargets)[0]!;
    store.admitWork({ ...common, logicalWorkId: "compact", instructionIdentity: "compact-item", purpose: "compaction",
      workPayloadDigest: continuityDigest("compact"), snapshotDigest: continuityDigest(checkpointSourceSummary), compactionTargetId: target.compactionTargetId });
    store.retireAttempt(checkpointSourceThread, { scope: checkpointSourceScope }, "compact", 0);
    store.commitCheckpoint(checkpointSourceThread, { scope: checkpointSourceScope }, { logicalWorkId: "compact", commitId: "commit-one",
      compactionTargetId: target.compactionTargetId, summaryDigest: continuityDigest(checkpointSourceSummary), coveredCallIds: [],
      nativeTurnId: checkpointSourceIdentity.turnId });
    return { store, directory, common };
  });
}
function outcome(input: unknown[], record: RecoveryContinuationRecord) {
  try { return checkpointSourceDecision(input, record); }
  catch (error) {
    const value = error as { code: string; status: number; retryable: boolean; message: string };
    return { code: value.code, status: value.status, retryable: value.retryable, message: value.message };
  }
}

for (const parent of [false, true]) test(`T5 source contract: committed store and independent read view parent ${parent}`, () => {
  const original = checkpointSourceItem(parent, !parent), marker = checkpointSourceMarker();
  const { store, directory, common } = committedSource(original);
  const finite = checkpointSourceView(original);
  const compare = (input: unknown[], expected: Record<string, unknown>) => {
    const live = store.get(checkpointSourceThread)!;
    const before = structuredClone(live), beforeInput = structuredClone(input), isolated = structuredClone(finite);
    expect(outcome(input, live)).toMatchObject(expected);
    expect(outcome(input, isolated)).toEqual(outcome(input, live));
    expect(input).toEqual(beforeInput);
    expect(isolated).toEqual(finite);
    expect(store.get(checkpointSourceThread)).toEqual(before);
  };
  compare([original, marker], { action: "admit", commit: "commit-one", work: "source", primary: [0], carried: true });
  compare([marker], { action: "admit", primary: [], carried: false });
  for (const field of ["role", "content", "turn", ...(parent ? ["author", "recipient"] as const : [])] as const) {
    compare([changedCheckpointSource(original, field), marker], { code: "continuity_source_unproven", status: 409, retryable: false });
  }
  if (parent) {
    const parsed = checkpointSourceRequest([changedCheckpointSource(original, "author"), marker]);
    const live = store.get(checkpointSourceThread)!;
    const selected = selectRecoveryContinuation(parsed, live, checkpointSourceIdentity)!;
    expect(selected.action).toBe("admit");
    expect(() => recoveryContinuationPrimaryIndices(parsed, selected.checkpoint, live.works.source!)).toThrow("primary conflicts");
  } else {
    const parts = original.content as unknown[];
    compare([marker, { ...original, content: [...parts].reverse() }], { code: "continuity_source_unproven" });
    compare([marker, { ...original, content: [{ type: "input_text", text: "Changed source instruction." }, parts[1]] }], { code: "continuity_source_unproven" });
  }
  compare([original, marker], { action: "admit" });
  // A distinct current item takes the ordinary admission path in both record forms.
  compare([{ ...original, id: "new-instruction" }, marker], { action: "none" });
  const copy = structuredClone(finite);
  copy.checkpoints["commit-one"]!.representationDigests.length = 0;
  expect(finite.checkpoints["commit-one"]!.representationDigests).toHaveLength(1);
  const readCopy = store.get(checkpointSourceThread)!;
  readCopy.checkpoints["commit-one"]!.representationDigests.length = 0;
  expect(store.get(checkpointSourceThread)!.checkpoints["commit-one"]!.representationDigests).toHaveLength(1);
  const consumer = { ...common, logicalWorkId: "consumer", instructionIdentity: "source-instruction",
    workPayloadDigest: continuityDigest("source-payload"), snapshotDigest: continuityDigest("continuation") };
  store.consumeContinuation(checkpointSourceThread, { scope: checkpointSourceScope }, "commit-one", consumer);
  const resumed = new ContinuityRecoveryStore(directory).get(checkpointSourceThread)!;
  // A view is a copied projection of committed reads; it has no transition implementation.
  const view: RecoveryContinuationRecord = structuredClone({ thread: resumed.thread, scope: resumed.scope, legacyUnproven: resumed.legacyUnproven,
    works: resumed.works, checkpoints: resumed.checkpoints, calls: resumed.calls });
  expect(outcome([original, marker], resumed)).toMatchObject({ action: "resume", work: "consumer", consumer: "consumer" });
  expect(outcome([original, marker], view)).toEqual(outcome([original, marker], resumed));
  expect(outcome([marker], view)).toEqual(outcome([marker], resumed));
  store.completeWork(checkpointSourceThread, { scope: checkpointSourceScope }, "consumer", { receiptId: "final-receipt", digest: continuityDigest("final answer") });
  const completed = store.get(checkpointSourceThread)!;
  const replayView: RecoveryContinuationRecord = structuredClone({ thread: completed.thread, scope: completed.scope, legacyUnproven: completed.legacyUnproven,
    works: completed.works, checkpoints: completed.checkpoints, calls: completed.calls });
  expect(outcome([original, marker], completed)).toMatchObject({ action: "replay", work: "consumer" });
  expect(outcome([original, marker], replayView)).toEqual(outcome([original, marker], completed));
  expect(outcome([marker], replayView)).toEqual(outcome([marker], completed));
  expect(outcome([changedCheckpointSource(original, "content"), marker], replayView)).toEqual(outcome([changedCheckpointSource(original, "content"), marker], completed));
  expect(store.get(checkpointSourceThread)).toEqual(completed);
});
