import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "../src/responses/parser";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityRecoveryStore, continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { selectRecoveryContinuation } from "../src/adapters/chatgpt-web/continuity-recovery-continuation";
import { recoverCompactionInstruction, isAcceptedCompactionContinuation } from "../src/adapters/chatgpt-web/compaction-continuation";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scope = continuityDigest("continuation-scope");
const native = { threadId: "continuation-thread", turnId: "continuation-turn" };
const thread = continuityDigest(native.threadId);
const text = "Accepted task is unfinished; its real results are already known.";
function request(input: unknown[] = [{ type: "compaction", encrypted_content: encodeCompactionSummary(text) }]) {
  const parsed = parseRequest({ model: "gpt-5.6-sol", input,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: native.threadId, turn_id: native.turnId }) } });
  parsed._conversationPolicy = "continuity-first";
  parsed._continuityScope = scope;
  return parsed;
}
function fixture(completed = false) {
  const directory = mkdtempSync(join(tmpdir(), "continuity-consumer-")); roots.push(directory);
  new ContinuityRegistrationStore(directory).initialize();
  const store = new ContinuityRecoveryStore(directory);
  const owner = continuityProcessInstance();
  const payload = continuityDigest("original instruction payload");
  store.admitWork({ thread, scope, owner, logicalWorkId: "source", instructionIdentity: "original-item",
    nativeTurnId: native.turnId, workPayloadDigest: payload, snapshotDigest: continuityDigest("first snapshot"),
    createPage: true, dispatchProtocolComplete: true });
  if (completed) store.completeWork(thread, { scope }, "source", { receiptId: "answer-receipt", digest: continuityDigest("original answer") });
  else store.retireAttempt(thread, { scope }, "source", 0);
  let record = store.registerCompactionTarget(thread, { scope }, { sourceLogicalWorkId: "source", sourceIdentity: "original-item",
    representationDigests: [continuityDigest([native.turnId, "original-item", "Same source text.", { role: "user" }])] });
  const target = Object.values(record.compactionTargets)[0]!;
  store.admitWork({ thread, scope, owner, logicalWorkId: "compact", instructionIdentity: "compact-item", nativeTurnId: native.turnId,
    workPayloadDigest: continuityDigest("compact"), snapshotDigest: continuityDigest(text), purpose: "compaction",
    compactionTargetId: target.compactionTargetId, dispatchProtocolComplete: true });
  store.retireAttempt(thread, { scope }, "compact", 0);
  record = store.commitCheckpoint(thread, { scope }, { logicalWorkId: "compact", commitId: "commit-one", compactionTargetId: target.compactionTargetId,
    summaryDigest: continuityDigest(text), coveredCallIds: [], nativeTurnId: native.turnId,
    ...(completed ? { ordinaryFinalReceiptId: "answer-receipt" } : {}) });
  const consumer = { thread, scope, owner, logicalWorkId: "consumer", instructionIdentity: "original-item", nativeTurnId: native.turnId,
    workPayloadDigest: payload, snapshotDigest: continuityDigest("continuation snapshot"), createPage: true, dispatchProtocolComplete: true };
  return { directory, store, record, consumer };
}

test("checkpoint-only recognition remains read-only before admission and locates the same consumer after restart", () => {
  const { directory, store, record, consumer } = fixture();
  const parsed = request();
  parsed._continuityStateDirectory = directory;
  const before = selectRecoveryContinuation(parsed, record, native)!;
  expect(before.action).toBe("admit");
  expect(before.work.logicalWorkId).toBe("source");
  expect(store.get(thread)!.checkpoints["commit-one"]!.continuation.state).toBe("available");
  store.consumeContinuation(thread, { scope }, "commit-one", consumer);
  const restarted = new ContinuityRecoveryStore(directory);
  const consumed = selectRecoveryContinuation(parsed, restarted.get(thread)!, native)!;
  expect(consumed.action).toBe("resume");
  expect(consumed.consumerLogicalWorkId).toBe("consumer");
  expect(consumed.work.workPayloadDigest).toBe(consumer.workPayloadDigest);
  const stable = restarted.get(thread)!.version;
  selectRecoveryContinuation(parsed, restarted.get(thread)!, native);
  expect(restarted.get(thread)!.version).toBe(stable);
  expect(() => restarted.consumeContinuation(thread, { scope }, "commit-one", { ...consumer, logicalWorkId: "second-consumer" })).toThrow();
});

for (const stage of ["page-acquired", "send-possible"] as const) test(`consumed checkpoint-only identity survives a ${stage} crash`, () => {
  const { directory, store, consumer } = fixture();
  store.consumeContinuation(thread, { scope }, "commit-one", consumer);
  store.markAttempt(thread, { scope }, { logicalWorkId: "consumer", attempt: 0, stage });
  const restarted = new ContinuityRecoveryStore(directory);
  const result = selectRecoveryContinuation(request(), restarted.get(thread)!, native)!;
  expect(result.action).toBe("resume");
  expect(result.consumerLogicalWorkId).toBe("consumer");
  expect(result.work.attempts[0]!.stage).toBe(stage);
});

test("stopped consumer remains stopped; a completed source cannot allocate a checkpoint-only consumer", () => {
  const stopped = fixture();
  stopped.store.consumeContinuation(thread, { scope }, "commit-one", stopped.consumer);
  stopped.store.stopWork(thread, { scope }, "consumer", "user-stop");
  expect(selectRecoveryContinuation(request(), stopped.store.get(thread)!, native)!.action).toBe("stopped");
  const completed = fixture(true);
  const selection = selectRecoveryContinuation(request(), completed.record, native)!;
  expect(selection.action).toBe("replay");
  expect(selection.work.terminalReceiptId).toBe("answer-receipt");
  expect(completed.store.get(thread)!.checkpoints["commit-one"]!.continuation.state).toBe("available");
});

test("equal summaries require a unique durable source relationship", () => {
  const { record } = fixture();
  const second = structuredClone(record.checkpoints["commit-one"]!);
  second.commitId = "other-commit"; second.compactionTargetId = "other-target"; second.sourceHistoryRevision++;
  record.checkpoints[second.commitId] = second;
  expect(() => selectRecoveryContinuation(request(), record, native)).toThrow("cannot distinguish");
  expect(selectRecoveryContinuation(request(), record, { ...native, turnId: "foreign-turn" })).toBeUndefined();
  expect(() => selectRecoveryContinuation(request(), record, { ...native, threadId: "foreign-thread" })).toThrow();
});

function equalSummaryFixture() {
  const f = fixture();
  const owner = continuityProcessInstance();
  f.store.admitWork({ thread, scope, owner, logicalWorkId: "source-two", instructionIdentity: "second-item",
    nativeTurnId: native.turnId, workPayloadDigest: continuityDigest("second payload"), snapshotDigest: continuityDigest("second snapshot"),
    createPage: true, dispatchProtocolComplete: true });
  f.store.retireAttempt(thread, { scope }, "source-two", 0);
  const record = f.store.registerCompactionTarget(thread, { scope }, { sourceLogicalWorkId: "source-two", sourceIdentity: "second-item",
    representationDigests: [continuityDigest([native.turnId, "second-item", "Same source text.", { role: "user" }])] });
  const target = Object.values(record.compactionTargets).find(target => target.sourceLogicalWorkId === "source-two")!;
  f.store.admitWork({ thread, scope, owner, logicalWorkId: "compact-two", instructionIdentity: "compact-two-item", nativeTurnId: native.turnId,
    workPayloadDigest: continuityDigest("second compact"), snapshotDigest: continuityDigest(text), purpose: "compaction",
    compactionTargetId: target.compactionTargetId, dispatchProtocolComplete: true });
  f.store.retireAttempt(thread, { scope }, "compact-two", 0);
  f.store.commitCheckpoint(thread, { scope }, { logicalWorkId: "compact-two", commitId: "commit-two", compactionTargetId: target.compactionTargetId,
    summaryDigest: continuityDigest(text), coveredCallIds: [], nativeTurnId: native.turnId });
  return { ...f, record: new ContinuityRecoveryStore(f.directory).get(thread)! };
}

function sourceItem(id: string, content = "Same source text.") {
  return { type: "message", role: "user", id, content, internal_chat_message_metadata_passthrough: { turn_id: native.turnId } };
}

test("equal durable summaries use explicit accepted source identity after restart without choosing the latest head", () => {
  const { store, record } = equalSummaryFixture();
  const summaryItem = { type: "compaction", encrypted_content: encodeCompactionSummary(text) };
  for (const [id, commit] of [["original-item", "commit-one"], ["second-item", "commit-two"]]) {
    expect(selectRecoveryContinuation(request([sourceItem(id!), summaryItem]), record, native)!.checkpoint.commitId).toBe(commit!);
  }
  expect(() => selectRecoveryContinuation(request(), record, native)).toThrow("cannot distinguish");
  expect(store.get(thread)!.version).toBe(record.version);
  expect(Object.values(store.get(thread)!.checkpoints).every(checkpoint => checkpoint.continuation.state === "available")).toBe(true);
});

test("durable explicit source selection normalizes proven aliases and rejects modified source content", () => {
  const { record } = equalSummaryFixture();
  const summaryItem = { type: "compaction", encrypted_content: encodeCompactionSummary(text) };
  const aliased = request([sourceItem("display-item"), summaryItem]);
  aliased._chatGptMessageIdAliases = { "display-item": "second-item" };
  expect(selectRecoveryContinuation(aliased, record, native)!.checkpoint.commitId).toBe("commit-two");
  expect(() => selectRecoveryContinuation(request([sourceItem("second-item", "Changed source text."), summaryItem]), record, native))
    .toThrow("conflicts with its accepted checkpoint source");
  expect(selectRecoveryContinuation(request([summaryItem, sourceItem("new-item", "New instruction.")]), record, native)).toBeUndefined();
});

test("accepted local, v1/v2 and readable checkpoint representations locate the same relation", () => {
  const { record } = fixture();
  for (const type of ["compaction", "compaction_summary", "context_compaction"]) {
    const result = selectRecoveryContinuation(request([{ type, encrypted_content: encodeCompactionSummary(text) }]), record, native)!;
    expect(result.checkpoint.commitId).toBe("commit-one");
  }
  const result = selectRecoveryContinuation(request([{ role: "user", type: "message", content: `${SUMMARY_PREFIX}\n${text}` }]), record, native)!;
  expect(result.checkpoint.commitId).toBe("commit-one");
  expect(() => selectRecoveryContinuation(request([{ type: "compaction", encrypted_content: "untrusted ciphertext" }]), record, native)).toThrow();
});

test("trusted-environment recognition uses durable identity without inventing lost instruction content", () => {
  const { directory } = fixture();
  continuityBindingsFor(directory);
  const parsed = request();
  parsed._continuityStateDirectory = directory;
  const identity = extractChatGptTurnIdentity(parsed);
  const recovered = recoverCompactionInstruction(parsed, identity)!;
  expect(recovered.source.itemId).toBe("original-item");
  expect(recovered.source.content).toEqual([]);
  expect(isAcceptedCompactionContinuation(parsed, identity, recovered.source)).toBe(true);
  expect(isAcceptedCompactionContinuation(parsed, identity, { ...recovered.source })).toBe(false);
  const newInstruction = request([{ type: "compaction", encrypted_content: encodeCompactionSummary(text) },
    { type: "message", role: "user", id: "distinct-item", content: "New user instruction.", internal_chat_message_metadata_passthrough: { turn_id: native.turnId } }]);
  newInstruction._continuityStateDirectory = directory;
  expect(recoverCompactionInstruction(newInstruction, extractChatGptTurnIdentity(newInstruction))).toBeUndefined();
});
