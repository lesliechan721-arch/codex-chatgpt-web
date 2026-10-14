import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContinuityFixture, continuityLivePlan, FIXTURE_BYTES, inspectContinuityEvidence, parseContinuityLiveArgs,
  type ReadEvidence } from "../scripts/validate-unified-task-continuity";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { ContextNavigator } from "../src/adapters/chatgpt-web/context-navigator";
import { parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import { parseRequest } from "../src/responses/parser";

test("fixture has a bounded fixed layout and never puts its private answer in the task or plan", () => {
  const fixture = createContinuityFixture("1".repeat(48));
  expect(Buffer.byteLength(fixture.text)).toBe(FIXTURE_BYTES);
  expect(fixture.tailValue).toMatch(/^UC[a-f0-9]{48}$/);
  expect(fixture.text).toContain(`tailValue=${fixture.tailValue}`);
  expect(fixture.task).toContain('{"tailValue":"the exact value from the source body"}');
  expect(continuityLivePlan().fixture.version).toBe(2);
  expect(Buffer.from(fixture.text).subarray(fixture.tailStart, fixture.tailEnd).toString()).toBe(fixture.tailValue);
  expect(fixture.tailStart).toBeGreaterThan(FIXTURE_BYTES - 128);
  expect(fixture.task).not.toContain(fixture.tailValue);
  expect(JSON.stringify(continuityLivePlan())).not.toContain(fixture.tailValue);
  expect(() => createContinuityFixture("guessable")).toThrow("entropy");
});

test("real navigation search finds a signed read cursor without revealing the answer; body read recovers exact bytes", () => {
  const fixture = createContinuityFixture("2".repeat(48));
  const parsed = parseRequest({ model: "chatgpt-web/gpt-6-sol-instant", input: [
    { type: "function_call", name: "continuity_fixture_source", call_id: "actual_fixture_call", arguments: "{}" },
    { type: "function_call_output", call_id: "actual_fixture_call", output: fixture.text },
  ] });
  const snapshot = createContextSnapshot(parsed);
  const target = snapshot.targets.find(target => target.kind === "tool_result")!;
  expect(target.utf8_bytes).toBe(FIXTURE_BYTES);
  const navigator = new ContextNavigator({ scopeId: "isolated-test", snapshot, purpose: "normal" });
  const opening = parseContextTextReadResult(navigator.read({ context_id: snapshot.context_id, read_ref: target.read_ref! }));
  expect(opening.metadata.range.start).toBe(0);
  expect(opening.body).toStartWith("CONTINUITY_HEAD");
  expect(opening.body).not.toContain(fixture.tailValue);
  const search = navigator.search({ context_id: snapshot.context_id, read_ref: target.read_ref!, query: "CONTINUITY_TAIL_TARGET" });
  expect(search.isError).not.toBe(true);
  expect(JSON.stringify(search)).not.toContain(fixture.tailValue);
  const hits = (search.structuredContent as { hits: Array<{ read_cursor: string; read_ref: string }> }).hits;
  expect(hits).toHaveLength(1);
  const tail = parseContextTextReadResult(navigator.read({ context_id: snapshot.context_id, read_ref: hits[0]!.read_ref, cursor: hits[0]!.read_cursor }));
  expect(tail.body).toContain(fixture.tailValue);
  expect(Buffer.from(tail.body).equals(Buffer.from(fixture.text).subarray(tail.metadata.range.start, tail.metadata.range.end_exclusive))).toBe(true);
});

test("only explicit run accepts a sending action; invalid, duplicate and removed mode parameters fail before any runtime action", () => {
  expect(parseContinuityLiveArgs([])).toEqual({ action: "check" });
  expect(parseContinuityLiveArgs(["--check-only"])).toEqual({ action: "check" });
  expect(parseContinuityLiveArgs(["plan"])).toEqual({ action: "plan" });
  expect(() => parseContinuityLiveArgs(["--case=ordinary-recovery"])).toThrow("run");
  const valid = ["run", "--case=ordinary-recovery", "--mode=automatic", "--model=chatgpt-web/gpt-6-sol-instant"];
  expect(parseContinuityLiveArgs(valid).action).toBe("run");
  expect(() => parseContinuityLiveArgs([...valid, "--case=healthy-incremental"])).toThrow("run");
  expect(() => parseContinuityLiveArgs(valid.map(value => value.startsWith("--model=") ? "--model=chatgpt-web-continuity/gpt-6-sol-instant" : value))).toThrow("旧模式");
  expect(() => parseContinuityLiveArgs(valid.map(value => value === "--mode=automatic" ? "--mode=zero-risk" : value))).toThrow("不会代办人工 Send/Sent");
});

test("oracle needs actual confirmed reads, a changed page and entry, exact answer, no stop and one dispatch per tool", () => {
  const fixture = createContinuityFixture("3".repeat(48));
  const reads: ReadEvidence[] = [
    { phase: "opening", contextDigest: "old-entry", start: 0, end: 2048, bytes: 2048, exact: true, confirmed: true, tail: false },
    { phase: "continuation", contextDigest: "new-entry", start: fixture.tailStart - 64, end: fixture.tailEnd, bytes: 115, exact: true, confirmed: true, tail: true },
  ];
  const calls = [{ name: "continuity_fixture_source" }, { name: "continuity_fixture_gate" }];
  const valid = { fault: true, oldTarget: "real-old-target", newTarget: "real-new-target", selectedResume: false, oldStopped: false, newStopped: false, tailValue: fixture.tailValue };
  expect(inspectContinuityEvidence(fixture, reads, calls, valid).passed).toBe(true);
  expect(inspectContinuityEvidence(fixture, reads.map(row => ({ ...row, confirmed: false })), calls, valid).passed).toBe(false);
  expect(inspectContinuityEvidence(fixture, reads, calls, { ...valid, newTarget: valid.oldTarget }).passed).toBe(false);
  expect(inspectContinuityEvidence(fixture, reads.map(row => ({ ...row, contextDigest: "old-entry" })), calls, valid).passed).toBe(false);
  expect(inspectContinuityEvidence(fixture, reads, [...calls, calls[0]!], valid).passed).toBe(false);
  expect(inspectContinuityEvidence(fixture, reads, calls, { ...valid, newStopped: true }).passed).toBe(false);
  expect(inspectContinuityEvidence(fixture, reads, calls, { ...valid, tailValue: "guessed" }).passed).toBe(false);
  // Mirror the actual consumers: parse the whole JSON and compare only the
  // required current field against the value proven by the original body read.
  for (const wrong of [{ tail_value: fixture.tailValue }, { tailValue: "guessed" }, {}, { tailValue: "UC\\literal" }]) {
    const extracted = JSON.parse(JSON.stringify(wrong));
    expect(inspectContinuityEvidence(fixture, reads, calls, { ...valid, tailValue: extracted.tailValue }).passed).toBe(false);
  }
  expect(inspectContinuityEvidence(fixture, reads, calls, { ...valid, fault: false, newTarget: valid.oldTarget }).passed).toBe(false);
  expect(inspectContinuityEvidence(fixture, reads, calls, { ...valid, fault: false, newTarget: valid.oldTarget, selectedResume: true }).passed).toBe(true);
});

test("read cost counts repeated reads as repeated bytes and does not discard failed reads", () => {
  const fixture = createContinuityFixture("4".repeat(48));
  const rows: ReadEvidence[] = [
    { phase: "opening", contextDigest: "a", start: 0, end: 100, bytes: 100, exact: true, confirmed: true, tail: false },
    { phase: "continuation", contextDigest: "b", start: 50, end: 150, bytes: 100, exact: true, confirmed: true, tail: false },
    { phase: "continuation", contextDigest: "b", start: 150, end: 250, bytes: 100, exact: true, confirmed: false, tail: false },
  ];
  const result = inspectContinuityEvidence(fixture, rows, [], { fault: true, oldTarget: "a", newTarget: "b", selectedResume: false, oldStopped: false, newStopped: false, tailValue: "" });
  expect(result.preparedReadBytes).toBe(300);
  expect(result.deliveredReadBytes).toBe(200);
  expect(result.uniqueReadBytes).toBe(150);
  expect(result.repeatedReadBytes).toBe(50);
  expect(result.unconfirmedReadBytes).toBe(100);
  expect(result.passed).toBe(false);
});

// These are local decision-oracle inputs. They are never durable product records or live evidence.
import { actualCheckpoint, compactionBody, checkpointContinuationBody, inspectTransitionEvidence, observeCheckpointResponse, parseTransitionArgs,
  summarizeCheckpointResponse, transitionTask,
  type TransitionEvidence } from "../scripts/validate-unified-task-continuity-transitions";
import { encodeCompactionSummary } from "../src/responses/compaction";
import type { RecoveryThreadRecord } from "../src/adapters/chatgpt-web/continuity-recovery-store";

function transitionOracle(name: "checkpoint-recovery" | "uncommitted-compaction"): TransitionEvidence {
  const fixture = createContinuityFixture("5".repeat(48));
  const ordinary = { logicalWorkId: "source", purpose: "ordinary", state: "active", attempts: [{ attempt: 0, epoch: 1 }], acceptedTaskRevision: 4 };
  const compact = { logicalWorkId: "compact", purpose: "compaction", compactionTargetId: "target", state: "active", acceptedTaskRevision: 4,
    attempts: [{ attempt: 0, epoch: 2, stage: "accepted", snapshotDigest: "first-snapshot", historyRevision: 3 }], retryBudget: { attempts: 1, startedAt: 100, deadlineAt: 200 } };
  const before = { epoch: 1, historyRevision: 3, checkpoints: {}, works: { source: ordinary }, calls: {} } as unknown as RecoveryThreadRecord;
  const fault = { ...structuredClone(before), epoch: 2, currentWorkId: "compact", works: { ...before.works, compact } } as unknown as RecoveryThreadRecord;
  const after = { epoch: name === "checkpoint-recovery" ? 4 : 3, historyRevision: 4, checkpoints: { target: { commitId: "commit", compactionTargetId: "target", targetHistoryRevision: 4,
    continuation: { state: "consumed", consumerLogicalWorkId: "consumer" } } },
    works: { source: ordinary, compact: { ...compact, state: "completed", attempts: name === "checkpoint-recovery" ? compact.attempts : [...compact.attempts, { attempt: 1, epoch: 3, stage: "completed", snapshotDigest: "successor-snapshot", historyRevision: 3 }], retryBudget: { ...compact.retryBudget, attempts: name === "checkpoint-recovery" ? 1 : 2 } } },
    calls: { a: { callId: "source-call", state: "settled", firstResultDigest: "source-result" }, b: { callId: "gate-call", state: "settled", firstResultDigest: "gate-result" } } } as unknown as RecoveryThreadRecord;
  const summary = name === "checkpoint-recovery" ? "The source tail is unread; continue the task." : `Read the tail body: ${fixture.tailValue}`;
  after.checkpoints.target!.summaryDigest = continuityDigest(summary);
  after.checkpoints.target!.sourceHistoryRevision = before.historyRevision;
  after.checkpoints.target!.coveredCallIds = ["source-call", "gate-call"];
  after.works.compact!.terminalReceiptId = "commit"; after.works.compact!.terminalDigest = after.checkpoints.target!.summaryDigest;
  // This is the production terminal shape: commitCheckpoint deletes retryBudget.
  delete after.works.compact!.retryBudget;
  const preCommit = structuredClone(fault);
  preCommit.epoch = 3;
  preCommit.works.compact!.attempts.push({ ...preCommit.works.compact!.attempts.at(-1)!, attempt: 1, epoch: 3, snapshotDigest: "successor-snapshot", stage: "accepted" });
  preCommit.works.compact!.retryBudget!.attempts++;
  const phase = name === "checkpoint-recovery" ? "checkpoint-continuation" : "compaction-retry";
  const reads: ReadEvidence[] = [{ phase: "opening", contextDigest: "ordinary-entry", start: 0, end: 100, bytes: 100, exact: true, confirmed: true, tail: false },
    { phase, contextDigest: "successor-entry", start: fixture.tailStart, end: fixture.tailEnd, bytes: fixture.tailEnd - fixture.tailStart, exact: true, confirmed: true, tail: true }];
  if (name === "checkpoint-recovery") reads.push({ phase: "compaction-checkpoint", contextDigest: "committed-compaction-entry", start: 0, end: 100, bytes: 100, exact: true, confirmed: true, tail: false });
  if (name === "uncommitted-compaction") reads.push({ phase: "compaction-first", contextDigest: "failed-compaction-entry", start: 0, end: 100, bytes: 100, exact: true, confirmed: true, tail: false },
    { phase: "compaction-retry", contextDigest: "successor-entry", start: 0, end: 100, bytes: 100, exact: true, confirmed: true, tail: false });
  return { case: name, fixture, before, after, faultRecord: fault, rejectedRecord: fault, preCommitRecord: preCommit, preCommitRead: name === "uncommitted-compaction" ? reads.at(-1) : undefined, reads,
    calls: [{ name: "continuity_fixture_source" }, { name: "continuity_fixture_gate" }],
    results: [{ callId: "source-call", firstResultDigest: "source-result" }, { callId: "gate-call", firstResultDigest: "gate-result" }],
    plans: [{ phase, contextDigest: "successor-entry", selected: true, hasNavigationEntry: true }], oldTarget: "physical-before", newTarget: "physical-after",
    summary,
    answer: fixture.tailValue, compactBodyDigest: "original-public-body", retryBodyDigest: "original-public-body" };
}

test("transition public bodies retain actual source identities and consume only an actual response marker", () => {
  const fixture = createContinuityFixture("6".repeat(48));
  expect(transitionTask(fixture, "checkpoint-recovery")).not.toContain(fixture.tailValue);
  expect(transitionTask(fixture, "uncommitted-compaction")).not.toContain(fixture.tailValue);
  const body = { model: "chatgpt-web/gpt-6-sol-instant", client_metadata: { "x-codex-turn-metadata": "actual source binding" }, input: [
    { type: "message", role: "user", id: "actual-user-id", turn_id: "actual-native-turn", content: "task" },
    { type: "function_call", call_id: "actual-call", name: "continuity_fixture_source", arguments: "{}" },
    { type: "function_call_output", call_id: "actual-call", output: "actual fixture return" },
  ] };
  const compact = compactionBody(body);
  expect(compact.input.slice(0, -1)).toEqual(body.input);
  expect(compact.input.at(-1)).toEqual({ type: "compaction_trigger" });
  expect(compact.client_metadata).toEqual(body.client_metadata);
  const envelope = { status: "completed", output: [{ type: "compaction", encrypted_content: encodeCompactionSummary("local test summary only") }] };
  expect(checkpointContinuationBody(body, envelope).input).toEqual([...envelope.output, ...body.input]);
  expect(body.input).toHaveLength(3);
  expect(() => checkpointContinuationBody(body, { status: "completed", output: [] })).toThrow("真实压缩返回格式无效");
  expect(() => compactionBody(compact)).toThrow();
  expect(parseTransitionArgs(["plan"])).toEqual({ action: "plan" });
  expect(() => parseTransitionArgs(["run", "--case=checkpoint-recovery", "--mode=zero-risk", "--model=chatgpt-web/zero-risk"])).toThrow("人工 Send/Sent");
});

test("checkpoint oracle rejects tail disclosure before commit, missing actual entry or repeated commit/calls", () => {
  const valid = transitionOracle("checkpoint-recovery");
  expect(inspectTransitionEvidence(valid).passed).toBe(true);
  expect(inspectTransitionEvidence({ ...valid, summary: valid.fixture.tailValue }).passed).toBe(false);
  expect(inspectTransitionEvidence({ ...valid, plans: [] }).passed).toBe(false);
  expect(inspectTransitionEvidence({ ...valid, calls: [...valid.calls, valid.calls[0]!] }).passed).toBe(false);
  const duplicate = structuredClone(valid); duplicate.after.checkpoints.other = duplicate.after.checkpoints.target!;
  expect(inspectTransitionEvidence(duplicate).passed).toBe(false);
  const unconsumed = structuredClone(valid); unconsumed.after.checkpoints.target!.continuation = { state: "available" };
  expect(inspectTransitionEvidence(unconsumed).passed).toBe(false);
  const changedResult = structuredClone(valid); changedResult.after.calls.a!.firstResultDigest = "fabricated-result";
  expect(inspectTransitionEvidence(changedResult).passed).toBe(false);
});

test("repair13: checkpoint oracle accepts repeated read-only heads and preserves their full cost", () => {
  const value = transitionOracle("checkpoint-recovery");
  const head = value.reads.find(row => row.phase === "compaction-checkpoint")!;
  const before = inspectTransitionEvidence(value).deliveredReadBytes;
  value.reads.push({ ...head }, { ...head });
  const original = structuredClone(value.reads);
  const result = inspectTransitionEvidence(value);
  expect(result.failures).toEqual([]);
  expect(result.passed).toBe(true);
  expect(result.deliveredReadBytes).toBe(before + 2 * head.bytes);
  expect(value.reads).toEqual(original);
});

for (const invalid of ["missing-head", "tail-read", "old-entry", "wrong-summary", "wrong-answer", "extra-business", "extra-commit"] as const) {
  test(`repair13: repeated heads do not excuse ${invalid}`, () => {
    const value = transitionOracle("checkpoint-recovery");
    const head = value.reads.find(row => row.phase === "compaction-checkpoint")!;
    value.reads.push({ ...head }, { ...head });
    if (invalid === "missing-head") value.reads = value.reads.filter(row => row.phase !== "compaction-checkpoint");
    if (invalid === "tail-read") value.reads.push({ ...head, start: value.fixture.tailStart, end: value.fixture.tailEnd, tail: true });
    if (invalid === "old-entry") head.contextDigest = "successor-entry";
    if (invalid === "wrong-summary") value.summary = "An unrelated summary.";
    if (invalid === "wrong-answer") value.answer = "An incorrect answer.";
    if (invalid === "extra-business") value.calls.push({ ...value.calls[0] });
    if (invalid === "extra-commit") value.after.checkpoints.extra = { ...value.after.checkpoints.target! };
    expect(inspectTransitionEvidence(value).passed).toBe(false);
  });
}

test("uncommitted compaction oracle requires original target/work/deadline, one successor and real new-entry tail read", () => {
  const valid = transitionOracle("uncommitted-compaction");
  expect(valid.after.works.compact!.retryBudget).toBeUndefined();
  expect(() => inspectTransitionEvidence(valid)).not.toThrow();
  expect(inspectTransitionEvidence(valid).passed).toBe(true);
  for (const key of ["startedAt", "deadlineAt"] as const) {
    const changed = structuredClone(valid); changed.preCommitRecord!.works.compact!.retryBudget![key]++;
    expect(inspectTransitionEvidence(changed).passed).toBe(false);
  }
  const changedTarget = structuredClone(valid); changedTarget.after.works.compact!.compactionTargetId = "different-target";
  expect(inspectTransitionEvidence(changedTarget).passed).toBe(false);
  const extra = structuredClone(valid); extra.after.works.compact!.attempts.push({ ...extra.after.works.compact!.attempts.at(-1)!, attempt: 2 });
  expect(inspectTransitionEvidence(extra).passed).toBe(false);
  const early = structuredClone(valid); early.rejectedRecord!.checkpoints = early.after.checkpoints;
  expect(inspectTransitionEvidence(early).passed).toBe(false);
  expect(inspectTransitionEvidence({ ...valid, retryBodyDigest: "new-body" }).passed).toBe(false);
  expect(inspectTransitionEvidence({ ...valid, reads: valid.reads.map(row => row.phase === "compaction-retry" ? { ...row, confirmed: false } : row) }).passed).toBe(false);
  expect(inspectTransitionEvidence({ ...valid, summary: "guessed" }).passed).toBe(false);
});

import { collectContinuityCapabilities, redactContinuityEvidence } from "../scripts/validate-unified-task-continuity";
test("evidence and assertion errors redact actual opaque Send authorization and all context/handoff control capabilities", () => {
  const opaque = "7".repeat(48), context = `context_${"8".repeat(32)}`;
  const secrets = new Set<string>();
  collectContinuityCapabilities({ attempts: [{ sendEvidence: { authorizationId: opaque } }], first_call: { arguments: { context_id: context } } }, secrets);
  const error = `${opaque} ${context} control_${"a".repeat(32)} handoff_${"b".repeat(32)} compaction_${"c".repeat(32)} turn_${"d".repeat(32)}`;
  const safe = redactContinuityEvidence(error, secrets);
  expect(safe).not.toContain(opaque); expect(safe).not.toContain(context);
  expect(safe).not.toContain("control_"); expect(safe).not.toContain("handoff_"); expect(safe).not.toContain("compaction_"); expect(safe).not.toContain("turn_");
  expect(redactContinuityEvidence("synthetic tail UC_1234; source digest abc", secrets)).toBe("synthetic tail UC_1234; source digest abc");
});

import { continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import { buildResponseJSON } from "../src/bridge";
test("native checkpoint consumer selects the entire final from actual builder commentary and preserves canonical bytes", () => {
  const summary = 'Actual summary.\n\nCODEX_LATEST_USER_PROMPT_JSON\n"Original accepted task."\n';
  const envelope = buildResponseJSON([{ type: "text_delta", phase: "commentary", text: "A new ChatGPT conversation was created with the current context." },
    { type: "text_delta", phase: "final_answer", text: summary }, { type: "done", endTurn: true }], "chatgpt-web/gpt-6-sol-instant");
  const selected = actualCheckpoint(envelope);
  expect(selected).toEqual({ marker: undefined, summary, format: "native-text" });
  expect(continuityDigest(selected.summary)).toBe(continuityDigest(summary));
  const source = { model: "chatgpt-web/gpt-6-sol-instant", input: [{ type: "message", role: "user", id: "original-user", content: "Original accepted task." }] };
  const consumer = checkpointContinuationBody(source, envelope);
  expect(consumer.input[0]).toEqual(source.input[0]);
  expect(consumer.input.at(-1).content[0].text).toBe(`${SUMMARY_PREFIX}\n${summary}`);
});

function nativeCheckpointEnvelope() {
  return buildResponseJSON([{ type: "text_delta", phase: "commentary", text: "Decoy checkpoint summary; do not select it." },
    { type: "text_delta", phase: "final_answer", text: "Actual checkpoint final.\n" }, { type: "done", endTurn: true }],
  "chatgpt-web/gpt-6-sol-instant") as Record<string, any>;
}

test.each([
  { name: "multiple finals", mutate: (value: Record<string, any>) => { value.output.push(structuredClone(value.output.at(-1))); } },
  { name: "only commentary", mutate: (value: Record<string, any>) => { value.output.pop(); } },
  { name: "no output", mutate: (value: Record<string, any>) => { value.output = []; } },
  { name: "missing phase", mutate: (value: Record<string, any>) => { delete value.output[0].phase; } },
  { name: "unknown phase", mutate: (value: Record<string, any>) => { value.output[0].phase = "unknown"; } },
  { name: "wrong role", mutate: (value: Record<string, any>) => { value.output.at(-1).role = "user"; } },
  { name: "unfinished message", mutate: (value: Record<string, any>) => { value.output.at(-1).status = "in_progress"; } },
  { name: "wrong content type", mutate: (value: Record<string, any>) => { value.output.at(-1).content[0].type = "refusal"; } },
  { name: "non-string body", mutate: (value: Record<string, any>) => { value.output.at(-1).content[0].text = { body: "not text" }; } },
  { name: "empty final", mutate: (value: Record<string, any>) => { value.output.at(-1).content[0].text = "  "; } },
  { name: "failed envelope", mutate: (value: Record<string, any>) => { value.status = "failed"; } },
  { name: "no end_turn", mutate: (value: Record<string, any>) => { delete value.end_turn; } },
  { name: "end_turn false", mutate: (value: Record<string, any>) => { value.end_turn = false; } },
  { name: "business output", mutate: (value: Record<string, any>) => { value.output.push({ type: "function_call", arguments: "{}" }); } },
  { name: "unknown output", mutate: (value: Record<string, any>) => { value.output.push({ type: "unknown" }); } },
])("native checkpoint rejects $name after preserving structure on disk", control => {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-structure-test-")), path = join(root, "evidence.json");
  try {
    const envelope = nativeCheckpointEnvelope(); control.mutate(envelope); const original = JSON.stringify(envelope);
    const observed = observeCheckpointResponse(envelope, structure => writeFileSync(path, JSON.stringify(structure)));
    expect(observed).toBe(envelope); expect(() => actualCheckpoint(observed)).toThrow();
    expect(JSON.stringify(envelope)).toBe(original);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.outputCount).toBe(envelope.output.length); expect(saved.schema).toBe("checkpoint-response-structure/v1");
    expect(readFileSync(path, "utf8")).not.toContain("Actual checkpoint final");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native checkpoint accepts auxiliary reasoning while preserving full final bytes, and never records its transcript", () => {
  const raw = "Private reasoning text must not enter evidence.", envelope = nativeCheckpointEnvelope();
  envelope.output.unshift({ type: "reasoning", id: "opaque-reasoning-id", content: [{ type: "reasoning_text", text: raw }] });
  expect(actualCheckpoint(envelope).summary).toBe("Actual checkpoint final.\n");
  const saved = summarizeCheckpointResponse(envelope);
  expect(saved.items[0]).toMatchObject({ type: "reasoning", bodyBytes: null, bodyDigest: null });
  expect(JSON.stringify(saved)).not.toContain(raw); expect(JSON.stringify(saved)).not.toContain("opaque-reasoning-id");
});

test.each([
  { name: "response status", mutate: (value: Record<string, any>, secret: string) => { value.status = secret; } },
  { name: "response end_turn", mutate: (value: Record<string, any>, secret: string) => { value.end_turn = { raw: secret }; } },
  { name: "message role", mutate: (value: Record<string, any>, secret: string) => { value.output.at(-1).role = secret; } },
  { name: "message status", mutate: (value: Record<string, any>, secret: string) => { value.output.at(-1).status = secret; } },
])("checkpoint parse error cannot leak unknown $name through the final report", control => {
  const secret = "SYNTHETIC_UNREGISTERED_BODY_DO_NOT_COPY", envelope = nativeCheckpointEnvelope();
  control.mutate(envelope, secret);
  const report: Record<string, any> = {};
  try {
    actualCheckpoint(observeCheckpointResponse(envelope, structure => { report.response = structure; }));
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  expect(typeof report.error).toBe("string");
  expect(report.response.outputCount).toBe(2);
  const serialized = redactContinuityEvidence(JSON.stringify(report), []);
  expect(serialized).not.toContain(secret);
});

test("checkpoint marker retains its original single-item contract and exact opaque return", () => {
  const summary = "Actual marker summary.\n", marker = { type: "compaction", id: "original-marker", encrypted_content: encodeCompactionSummary(summary) };
  const envelope = { status: "completed", output: [marker] };
  expect(actualCheckpoint(envelope)).toEqual({ marker, summary, format: "marker" });
  expect(actualCheckpoint(envelope).marker).not.toBe(marker);
  expect(() => actualCheckpoint({ ...envelope, output: [marker, marker] })).toThrow();
  expect(() => actualCheckpoint({ ...envelope, output: [marker, ...nativeCheckpointEnvelope().output] })).toThrow();
  expect(() => actualCheckpoint({ ...envelope, output: [{ ...marker, encrypted_content: encodeCompactionSummary(" ") }] })).toThrow();
  expect(() => actualCheckpoint({ ...envelope, output: [{ ...marker, encrypted_content: "opaque-unreadable" }] })).toThrow();
  const saved = JSON.stringify(summarizeCheckpointResponse(envelope));
  expect(saved).not.toContain(marker.encrypted_content); expect(saved).not.toContain(marker.id); expect(saved).not.toContain(summary);
});

test("checkpoint observation bounds both item and content counts without copying unknown values, errors or capability fields", () => {
  const secret = "unknown-delivery-and-body-not-in-the-secret-set", valid = nativeCheckpointEnvelope();
  const malicious = { type: secret, role: { raw: secret }, phase: secret, status: secret, id: secret, capability: secret,
    content: Array.from({ length: 15 }, () => ({ type: secret, text: secret, delivery_id: secret })) };
  const value = { status: secret, end_turn: { raw: secret }, error: { code: secret, message: secret, delivery_id: secret }, retryable: { raw: secret },
    output: [...valid.output, ...Array.from({ length: 40 }, () => malicious)] };
  const rows: ReturnType<typeof summarizeCheckpointResponse>[] = [];
  observeCheckpointResponse(value, row => rows.push(row));
  const saved = rows[0]!, serialized = redactContinuityEvidence(JSON.stringify({ responses: rows }), []);
  expect(saved.outputCount).toBe(42); expect(saved.outputTruncated).toBe(true); expect(saved.items).toHaveLength(saved.limits.outputItems);
  expect(saved.items[2]!.contentCount).toBe(15); expect(saved.items[2]!.contentTruncated).toBe(true);
  expect(saved.items[2]!.contentTypes).toHaveLength(saved.limits.contentParts);
  expect(saved.items[2]).toMatchObject({ type: null, phase: null, role: null, status: null });
  expect(saved.items[2]).toMatchObject({ invalidPhaseDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(serialized).not.toContain(secret); expect(serialized).not.toContain("delivery_id"); expect(serialized).not.toContain("capability");
  expect(serialized).not.toContain("Actual checkpoint final"); expect(Buffer.byteLength(serialized)).toBeLessThan(64 * 1024);
});

test("observing an intentionally failed first compaction does not parse it or replace its later retry evidence", () => {
  const rows: ReturnType<typeof summarizeCheckpointResponse>[] = [], first = { status: "failed", retryable: true, error: { code: "continuity_session_lost" }, output: [] };
  expect(observeCheckpointResponse(first, row => rows.push(row))).toBe(first);
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ outcome: "failed", outputCount: 0 });
  const retry = observeCheckpointResponse(nativeCheckpointEnvelope(), row => rows.push(row));
  expect(actualCheckpoint(retry).summary).toBe("Actual checkpoint final.\n");
  expect(rows).toHaveLength(2); expect(rows).toMatchObject([{ outcome: "failed" }, { outcome: "completed" }]);
});
test("native text-memento uses the existing public control-tail and actual returned text as the readable checkpoint", () => {
  const body = { model: "chatgpt-web/gpt-6-sol-instant", client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "actual-thread", turn_id: "actual-turn", request_kind: "turn" }) },
    input: [{ type: "message", role: "user", id: "actual-source-item", content: "original task" }] };
  const raw = compactionBody(body, "Read the actual head, then actual tail, then handoff.");
  const parsed = parseRequest(raw);
  expect(parsed._compactionRequest).toBe(true); expect(parsed._compactionOutput).toBe("message");
  expect(raw.input.slice(0, -1)).toEqual(body.input);
  expect(raw.input.at(-1).id).toBeUndefined(); expect(raw.input.at(-1).internal_chat_message_metadata_passthrough).toBeUndefined();
  const envelope = { status: "completed", end_turn: true, output: [{ type: "message", role: "assistant", status: "completed", phase: "final_answer",
    content: [{ type: "output_text", text: "Actual returned summary in this local test." }] }] };
  const consumer = checkpointContinuationBody(body, envelope);
  expect(consumer.input.slice(0, -1)).toEqual(body.input);
  expect(consumer.input.at(-1).content[0].text).toBe(`${SUMMARY_PREFIX}\nActual returned summary in this local test.`);
  expect(consumer.client_metadata).toEqual(body.client_metadata);
  expect(parseTransitionArgs(["run-zero-risk", "--boundary=active", "--mode=zero-risk", "--model=chatgpt-web/zero-risk"]).action).toBe("run-zero-risk");
  expect(() => parseTransitionArgs(["run-zero-risk", "--boundary=active", "--mode=automatic", "--model=chatgpt-web/zero-risk"])).toThrow("人工边界");
});


test("completed compaction validates its commit separately from the real pre-commit successor budget observation", () => {
  const valid = transitionOracle("uncommitted-compaction");
  expect(valid.after.works.compact!.retryBudget).toBeUndefined();
  expect(inspectTransitionEvidence(valid).passed).toBe(true);
  expect(inspectTransitionEvidence({ ...valid, preCommitRecord: undefined }).passed).toBe(false);
  const missingBudget = structuredClone(valid); delete missingBudget.preCommitRecord!.works.compact!.retryBudget;
  expect(() => inspectTransitionEvidence(missingBudget)).not.toThrow();
  expect(inspectTransitionEvidence(missingBudget).passed).toBe(false);
  const reset = structuredClone(valid); reset.preCommitRecord!.works.compact!.retryBudget!.attempts = 1;
  expect(inspectTransitionEvidence(reset).passed).toBe(false);
  for (const field of ["attempt", "epoch", "snapshotDigest"] as const) {
    const mismatch = structuredClone(valid), attempt = mismatch.preCommitRecord!.works.compact!.attempts.at(-1)!;
    if (field === "snapshotDigest") attempt[field] = "different-snapshot"; else attempt[field]++;
    expect(inspectTransitionEvidence(mismatch).passed).toBe(false);
  }
  const alreadyCommitted = structuredClone(valid); alreadyCommitted.preCommitRecord!.checkpoints = alreadyCommitted.after.checkpoints;
  expect(inspectTransitionEvidence(alreadyCommitted).passed).toBe(false);
  const oldRead = structuredClone(valid); oldRead.preCommitRead!.contextDigest = "failed-compaction-entry";
  expect(inspectTransitionEvidence(oldRead).passed).toBe(false);
  const badReceipt = structuredClone(valid); badReceipt.after.works.compact!.terminalReceiptId = "other-commit";
  expect(inspectTransitionEvidence(badReceipt).passed).toBe(false);
});
