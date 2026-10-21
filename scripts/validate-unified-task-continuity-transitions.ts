import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkContinuityDev, createContinuityFixture, runContinuityLive,
  collectContinuityCapabilities, redactContinuityEvidence, type ContinuityFixture, type ReadEvidence } from "./validate-unified-task-continuity";
import { decodeCompactionSummary, buildCompactV1Output, COMPACT_PROMPT } from "../src/responses/compaction";
import type { RecoveryThreadRecord, RecoveryWorkRecord } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { startLauncherManualTurn, waitForLauncherManualSent, waitForLauncherManualTerminal, markLauncherManualTurnStarted,
  endLauncherManualTurn, cancelLauncherManualTurn } from "../src/launcher-browser-host";
import { createLiveRequestBody } from "./validate-context-rendering";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web";
import { chatGptTurnSessions, chatGptTurnExecutionKey, type ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { recoveryRecord } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { startDevChatTransport } from "../src/dev-chat/transport";
import { callTurnBroker, type TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { responseRequest } from "../src/server";
import { closeChatGptBrowserWorkers } from "../src/adapters/chatgpt-web/browser-worker";
import { estimateTokens } from "../src/lib/token-estimate";
import { requireChatGptWebModelRoute } from "../src/chatgpt-web-models";
import { continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { providerConfig } from "../src/config";
import { prepareContinuityDevProvider, continuityDevProviderEvidence } from "./unified-task-continuity-dev-provider";
import { extractContinuityFinalResponseText, summarizeContinuityFinalResponse } from "./unified-task-continuity-final-response";
import { summarizeHarnessResponse } from "./unified-task-continuity-request-retry";

type Row = Record<string, any>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const TRANSITION_CASES = ["checkpoint-recovery", "uncommitted-compaction"] as const;
export type TransitionCase = typeof TRANSITION_CASES[number];
const SOURCE = "continuity_fixture_source", GATE = "continuity_fixture_gate";

export function transitionTask(fixture: ContinuityFixture, name: TransitionCase) {
  return fixture.task + "\n" + [
    "Checkpoint policy for this task: a dedicated CONTEXT CHECKPOINT COMPACTION is read-only. Do not run either work tool during compaction.",
    name === "checkpoint-recovery"
      ? "During checkpoint compaction, inspect the actual source opening page if needed, leave CONTINUITY_TAIL_TARGET and its tail value unread, and preserve the remaining task to search and read that tail after checkpoint continuation. The summary must say the tail is still unread and the original source is required; do not replace it with a guessed value."
      : "During checkpoint compaction, first use the actual compaction context entry to read one source opening page at offset zero. Then search CONTINUITY_TAIL_TARGET and read its body through read_cursor before submitting the real handoff. Include the exact tailValue in the handoff only after that body read has returned. Never guess it.",
  ].join("\n");
}

/** Public Responses input only. Native control is the existing text-memento client contract. */
export function compactionBody(body: Row, control?: string): Row {
  assert.ok(Array.isArray(body.input) && body.input.length);
  assert.ok(!body.input.some((item: Row) => item.type === "compaction_trigger"));
  if (control) {
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]);
    assert.ok(metadata.thread_id && metadata.turn_id && control.trim());
    return { ...structuredClone(body), stream: false, client_metadata: { ...body.client_metadata,
      "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "compaction",
        compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" } }) },
      input: [...structuredClone(body.input), { type: "message", role: "user", content: control }] };
  }
  return { ...structuredClone(body), stream: false, input: [...structuredClone(body.input), { type: "compaction_trigger" }] };
}
export function actualCheckpoint(envelope: Row) {
  try {
    assert.equal(envelope.status, "completed", "真实压缩请求未完成");
    assert.ok(Array.isArray(envelope.output) && envelope.output.length, "真实压缩缺少公开 output");
    if (!envelope.output.some((item: Row) => item?.type === "compaction")) {
      const summary = extractContinuityFinalResponseText(envelope);
      return { marker: undefined, summary, format: "native-text" as const };
    }
    assert.equal(envelope.output.length, 1, "真实压缩必须返回唯一公开 marker");
    const marker = envelope.output[0];
    assert.equal(marker.type, "compaction"); assert.equal(typeof marker.encrypted_content, "string");
    const summary = decodeCompactionSummary(marker.encrypted_content);
    assert.ok(typeof summary === "string" && summary.trim(), "缺少真实可读取摘要");
    return { marker: structuredClone(marker), summary, format: "marker" as const };
  } catch {
    // Assertion messages can include untrusted response values. Real callers save
    // the bounded structure before parsing, so this error must contain no raw fields.
    throw new Error("真实压缩返回格式无效；详见已保存的响应结构");
  }
}

const CHECKPOINT_OUTPUT_ITEM_LIMIT = 32, CHECKPOINT_CONTENT_PART_LIMIT = 8;
/** Structure only: auxiliary output is not a checkpoint, model-read proof or printable transcript. */
export function summarizeCheckpointResponse(envelope: Row) {
  const fingerprint = (value: unknown) => digest(JSON.stringify(value) ?? "undefined");
  const field = (source: Row, name: string, allowed: readonly string[]): Row => {
    const present = Object.hasOwn(source, name), value = source[name], known = typeof value === "string" && allowed.includes(value);
    return { [name]: known ? value : null, [`${name}Present`]: present,
      [`${name}Type`]: !present ? "absent" : value === null ? "null" : typeof value,
      ...(present && !known ? { [`invalid${name[0]!.toUpperCase()}${name.slice(1)}Digest`]: fingerprint(value) } : {}) };
  };
  const object = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
  const source = object(envelope), output = Array.isArray(source.output) ? source.output : undefined;
  return { schema: "checkpoint-response-structure/v1", ...summarizeHarnessResponse(source),
    outputPresent: Object.hasOwn(source, "output"), outputType: output ? "array" : source.output === null ? "null" : typeof source.output,
    outputCount: output?.length ?? null, outputTruncated: Boolean(output && output.length > CHECKPOINT_OUTPUT_ITEM_LIMIT),
    limits: { outputItems: CHECKPOINT_OUTPUT_ITEM_LIMIT, contentParts: CHECKPOINT_CONTENT_PART_LIMIT },
    items: (output ?? []).slice(0, CHECKPOINT_OUTPUT_ITEM_LIMIT).map((value: unknown) => {
      const item = object(value), content = Array.isArray(item.content) ? item.content : undefined;
      const textOnly = item.type === "message" && content?.length && content.every((part: unknown) => object(part).type === "output_text" && typeof object(part).text === "string");
      const text = textOnly ? content!.map((part: Row) => part.text).join("") : undefined;
      const encoded = item.type === "compaction" && typeof item.encrypted_content === "string" ? item.encrypted_content : undefined;
      return { valueType: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...field(item, "type", ["message", "reasoning", "compaction", "function_call", "custom_tool_call", "tool_search_call"]),
        ...field(item, "role", ["assistant", "user", "system", "developer", "tool"]),
        ...field(item, "status", ["completed", "incomplete", "in_progress"]), ...field(item, "phase", ["commentary", "final_answer"]),
        contentCount: content?.length ?? null, contentTruncated: Boolean(content && content.length > CHECKPOINT_CONTENT_PART_LIMIT),
        contentTypes: (content ?? []).slice(0, CHECKPOINT_CONTENT_PART_LIMIT).map((part: unknown) => ({
          valueType: part === null ? "null" : Array.isArray(part) ? "array" : typeof part,
          ...field(object(part), "type", ["output_text", "summary_text", "reasoning_text", "refusal"]) })),
        bodyBytes: text === undefined ? null : Buffer.byteLength(text), bodyDigest: text === undefined ? null : digest(text),
        canonicalTextDigest: text === undefined ? null : continuityDigest(text),
        encodedBytes: encoded === undefined ? null : Buffer.byteLength(encoded), encodedDigest: encoded === undefined ? null : digest(encoded) };
    }) };
}

/** Real callers synchronously save this projection before parsing, including intentionally failed first attempts. */
export function observeCheckpointResponse(envelope: Row, persist: (structure: ReturnType<typeof summarizeCheckpointResponse>) => void): Row {
  persist(summarizeCheckpointResponse(envelope));
  return envelope;
}

/** Observe the real Broker consumer without issuing a control or replacing its return. */
export function observeCompactionHandoff(broker: TurnBroker, thread: string, write: (event: Row) => void) {
  const target = broker as unknown as Row, original = target.dispatch;
  assert.equal(typeof original, "function");
  const own = Object.getOwnPropertyDescriptor(target, "dispatch");
  let sequence = 0, requests = 0;
  const emit = (event: Row) => { try { write({ ...event, sequence: ++sequence, at: new Date().toISOString(),
    observationBoundary: "broker-consumer", modelReadConfirmed: false }); } catch {} };
  const wrapper = function(this: unknown, ...args: any[]) {
    let observation: Row | undefined;
    try {
      const request = args[0];
      if (request?.method === "submit_compaction_handoff" && requests < 16) {
        // Read the binding directly: compactionScopeForSubmission performs a guard,
        // and calling it here would duplicate production validation.
        const readToken = target.compactionContextBindings.get(request.token)?.readToken;
        const ref = target.compactionContexts.get(readToken)?.registration.recovery;
        if (ref?.thread === thread) {
          const record = recoveryRecord(ref), work = record.works[ref.logicalWorkId], attempt = work?.attempts[ref.attempt];
          if (work?.purpose === "compaction" && attempt) {
            observation = { request: ++requests, workDigest: digest(work.logicalWorkId),
              targetDigest: digest(work.compactionTargetId!), attempt: attempt.attempt, epoch: attempt.epoch,
              tokenDigest: digest(request.token), handoffDigest: typeof request.handoffId === "string" ? digest(request.handoffId) : null,
              summaryBytes: typeof request.summary === "string" ? Buffer.byteLength(request.summary) : null,
              summaryDigest: typeof request.summary === "string" ? continuityDigest(request.summary) : null };
          }
        }
      }
    } catch { /* Observations cannot change dispatch. */ }
    if (observation) emit({ ...observation, stage: "arrived" });
    const accepted = (value: any) => { if (observation) { try {
      emit({ ...observation, stage: "returned", submitted: value?.submitted === true });
    } catch {} } };
    const rejected = (error: any) => { if (observation) {
      try {
        const code = ["continuity_source_unproven", "continuity_stopped", "continuity_execution_unsettled",
          "CONTEXT_BUSY", "CONTEXT_STALE", "CONTEXT_INVALID"].includes(error?.code) ? error.code : null;
        emit({ ...observation, stage: "rejected", code,
          errorDigest: digest(JSON.stringify({ code: error?.code, message: error?.message }) ?? "undefined") });
      } catch {}
    } };
    try {
      const returned = original.apply(this, args);
      if (returned instanceof Promise) void returned.then(accepted, rejected); else accepted(returned);
      return returned;
    } catch (error) { rejected(error); throw error; }
  };
  target.dispatch = wrapper;
  return () => { if (target.dispatch === wrapper) {
    if (own) Object.defineProperty(target, "dispatch", own); else delete target.dispatch;
  } };
}
export function checkpointContinuationBody(body: Row, envelope: Row): Row {
  const { marker, summary } = actualCheckpoint(envelope);
  // The exact original source remains a legitimate client-retained body. Its call/result
  // identities are unchanged; the marker is the actual public server output.
  return { ...structuredClone(body), input: marker ? [marker, ...structuredClone(body.input)]
    : [...structuredClone(body.input), ...buildCompactV1Output([], summary)], stream: false };
}
function compactWork(record: RecoveryThreadRecord): RecoveryWorkRecord {
  const works = Object.values(record.works).filter(work => work.purpose === "compaction");
  assert.equal(works.length, 1, "本 case 必须只有一个真实压缩 work"); return works[0]!;
}
export function summarizeTransitionJournal(record: RecoveryThreadRecord) {
  return { epoch: record.epoch, historyRevision: record.historyRevision, currentWorkDigest: record.currentWorkId ? digest(record.currentWorkId) : null,
    works: Object.values(record.works).map(work => ({ workDigest: digest(work.logicalWorkId), purpose: work.purpose, state: work.state,
      targetDigest: work.compactionTargetId ? digest(work.compactionTargetId) : null, taskRevision: work.acceptedTaskRevision,
      retryBudget: work.retryBudget, attempts: work.attempts.map(attempt => ({ attempt: attempt.attempt, epoch: attempt.epoch,
        snapshotDigest: attempt.snapshotDigest, historyRevision: attempt.historyRevision, stage: attempt.stage, writerRetired: attempt.writerRetired })) })),
    checkpoints: Object.values(record.checkpoints).map(checkpoint => ({ commitDigest: digest(checkpoint.commitId), targetDigest: digest(checkpoint.compactionTargetId),
      sourceWorkDigest: digest(checkpoint.sourceLogicalWorkId), sourceHistoryRevision: checkpoint.sourceHistoryRevision,
      targetHistoryRevision: checkpoint.targetHistoryRevision, summaryDigest: checkpoint.summaryDigest, coveredCallIds: checkpoint.coveredCallIds,
      continuation: { ...checkpoint.continuation, consumerLogicalWorkId: checkpoint.continuation.consumerLogicalWorkId ? digest(checkpoint.continuation.consumerLogicalWorkId) : undefined } })),
    calls: Object.values(record.calls).map(call => ({ callId: call.callId, state: call.state, firstResultDigest: call.firstResultDigest })) };
}

export interface TransitionEvidence {
  case: TransitionCase; fixture: ContinuityFixture; reads: ReadEvidence[]; calls: Row[]; results: Row[]; plans: Row[];
  oldTarget: string; newTarget: string; before: RecoveryThreadRecord; after: RecoveryThreadRecord;
  faultRecord?: RecoveryThreadRecord; rejectedRecord?: RecoveryThreadRecord;
  preCommitRecord?: RecoveryThreadRecord; preCommitRead?: ReadEvidence; summary: string; answer: string;
  compactBodyDigest: string; retryBodyDigest?: string;
}
/** Content and real durable bindings are required. Local oracle results are not DEV results. */
export function inspectTransitionEvidence(value: TransitionEvidence) {
  const failures: string[] = [];
  const { before, after, reads, fixture } = value;
  const opening = reads.filter(row => row.phase === "opening" && row.exact && row.confirmed);
  if (opening.length !== 1 || opening[0]?.start !== 0 || opening[0].end >= fixture.tailStart) failures.push("缺少唯一真实 ordinary 开头读取");
  if (!value.oldTarget || !value.newTarget || value.oldTarget === value.newTarget) failures.push("故障前后缺少不同真实页面身份");
  if (Object.values(after.works).some(work => work.state === "stopped")) failures.push("故障产生或保留了 stop");
  for (const name of [SOURCE, GATE]) if (value.calls.filter(call => call.name === name).length !== 1) failures.push(`${name} 不是唯一真实派发`);
  if (value.calls.some(call => ![SOURCE, GATE].includes(call.name))) failures.push("存在非预期业务派发");
  for (const result of value.results) if (!Object.values(after.calls).some(call => call.callId === result.callId && call.state === "settled" && call.firstResultDigest === result.firstResultDigest)) failures.push("真实外层结果未按首个 digest 结算");
  const checkpoints = Object.values(after.checkpoints);
  if (Object.keys(before.checkpoints).length || checkpoints.length !== 1) failures.push("真实 checkpoint 提交不是一次");
  const checkpoint = checkpoints[0];
  if (checkpoint && (checkpoint.summaryDigest !== continuityDigest(value.summary) || checkpoint.sourceHistoryRevision !== before.historyRevision)) failures.push("实际公开摘要未绑定该源 revision 的真实 commit");
  if (checkpoint && value.results.some(result => !checkpoint.coveredCallIds.includes(result.callId))) failures.push("真实 checkpoint 未覆盖已结算来源调用");
  if (checkpoint && (after.historyRevision !== checkpoint.targetHistoryRevision || checkpoint.targetHistoryRevision !== before.historyRevision + 1)) failures.push("checkpoint revision 不符合一次提交");
  const compactWorks = Object.values(after.works).filter(work => work.purpose === "compaction");
  if (compactWorks.length !== 1 || compactWorks[0]?.state !== "completed" || compactWorks[0]?.compactionTargetId !== checkpoint?.compactionTargetId) failures.push("压缩 target/work/完成关系不唯一");
  if (!checkpoint || compactWorks[0]?.terminalReceiptId !== checkpoint.commitId || compactWorks[0]?.terminalDigest !== checkpoint.summaryDigest) failures.push("真实 completed 终态未绑定唯一 commit 回执");
  const tailPhase = value.case === "checkpoint-recovery" ? "checkpoint-continuation" : "compaction-retry";
  const tail = reads.filter(row => row.phase === tailPhase && row.exact && row.confirmed && row.tail);
  if (!tail.length || !tail.some(row => value.plans.some(plan => plan.phase === tailPhase && plan.selected && plan.hasNavigationEntry && plan.contextDigest === row.contextDigest))) failures.push("后继没有通过实际所选入口真实读取尾值");
  if (opening.some(row => tail.some(last => row.contextDigest === last.contextDigest))) failures.push("后继使用原 ordinary 入口");
  if (value.answer !== fixture.tailValue) failures.push("真实读取后的答案错误");
  if (value.case === "checkpoint-recovery") {
    if (value.summary.includes(fixture.tailValue) || reads.some(row => row.phase.startsWith("compaction") && row.tail)) failures.push("checkpoint 之前已经泄漏或可能交付尾值");
    const compactHead = reads.filter(row => row.phase === "compaction-checkpoint" && row.exact && row.confirmed && row.start === 0);
    if (compactHead.length === 0 || compactHead.some(row => row.end >= fixture.tailStart || tail.some(last => row.contextDigest === last.contextDigest))) failures.push("缺少已提交压缩旧页的真实仅读开头和不同后继入口");
    if (checkpoint?.continuation.state !== "consumed" || !checkpoint.continuation.consumerLogicalWorkId) failures.push("真实 checkpoint 未按一次 consumer 继承");
    if (after.epoch <= before.epoch) failures.push("故障续接代次未推进");
  } else {
    const fault = value.faultRecord, rejected = value.rejectedRecord, preCommit = value.preCommitRecord;
    const initial = fault && Object.values(fault.works).find(work => work.purpose === "compaction");
    const successor = preCommit && Object.values(preCommit.works).find(work => work.purpose === "compaction");
    const final = compactWorks[0];
    if (!fault || !rejected || Object.keys(fault.checkpoints).length || Object.keys(rejected.checkpoints).length) failures.push("没有明确证明故障发生在真实提交前");
    if (!initial || !successor || !final || [successor, final].some(work => initial.logicalWorkId !== work.logicalWorkId || initial.compactionTargetId !== work.compactionTargetId || initial.acceptedTaskRevision !== work.acceptedTaskRevision)) failures.push("恢复重置了原 target/work/task");
    const initialBudget = initial?.retryBudget, successorBudget = successor?.retryBudget;
    if (!initialBudget?.deadlineAt || !successorBudget || initialBudget.deadlineAt !== successorBudget.deadlineAt || initialBudget.startedAt !== successorBudget.startedAt) failures.push("提交前观察的原压缩截止时间或累计预算被重置／缺失");
    const initialAttempt = initial?.attempts.at(-1), successorAttempt = successor?.attempts.at(-1), finalAttempt = final?.attempts.at(-1);
    if (!initial || !successor || !final || successor.attempts.length !== initial.attempts.length + 1 || final.attempts.length !== successor.attempts.length
      || !initialAttempt || !successorAttempt || !finalAttempt || successorAttempt.epoch <= initialAttempt.epoch
      || !initialBudget || !successorBudget || successorBudget.attempts !== initialBudget.attempts + 1) failures.push("没有唯一后继 attempt 和提交前累计重试");
    if (!preCommit || Object.keys(preCommit.checkpoints).length || !successor || successor.state !== "active" || preCommit.currentWorkId !== successor.logicalWorkId
      || successorAttempt?.stage !== "accepted" || preCommit.epoch !== successorAttempt.epoch || !finalAttempt
      || finalAttempt.attempt !== successorAttempt.attempt || finalAttempt.epoch !== successorAttempt.epoch
      || after.epoch !== finalAttempt.epoch || finalAttempt.snapshotDigest !== successorAttempt.snapshotDigest || finalAttempt.historyRevision !== successorAttempt.historyRevision) failures.push("提交前真实观察未绑定最终完成的同一后继 attempt／epoch／快照");
    const observedRead = value.preCommitRead;
    if (!observedRead || observedRead.phase !== "compaction-retry" || !observedRead.confirmed || !observedRead.exact || observedRead.start !== 0 || observedRead.tail
      || !reads.some(row => row.phase === observedRead.phase && row.contextDigest === observedRead.contextDigest && row.start === observedRead.start && row.end === observedRead.end && row.confirmed && row.exact)
      || !tail.some(row => row.contextDigest === observedRead.contextDigest)) failures.push("提交前预算观察缺少该后继真实 head 返回收据与当前入口绑定");
    if (value.compactBodyDigest !== value.retryBodyDigest) failures.push("重试没有保持原压缩 body");
    const first = reads.filter(row => row.phase === "compaction-first" && row.exact && row.confirmed);
    if (!first.some(row => row.start === 0) || reads.some(row => row.phase === "compaction-first" && row.tail) || first.some(row => tail.some(last => row.contextDigest === last.contextDigest))) failures.push("失页压缩没有真实仅读开头，或后继复用旧入口");
    if (!value.summary.includes(fixture.tailValue)) failures.push("真实 handoff 缺少后继读取的尾值");
  }
  return { passed: failures.length === 0, failures, deliveredReadBytes: reads.filter(row => row.confirmed).reduce((sum, row) => sum + row.bytes, 0) };
}

export function transitionsPlan() {
  return { schema: "unified-task-continuity-transitions-plan/v1", cases: TRANSITION_CASES, sendsExecuted: false,
    entry: "real public Responses native text-memento standalone control; actual returned text converted by the existing public SUMMARY_PREFIX client contract; unchanged native thread/turn/source IDs",
    common: ["real source call; seed-page fault before source result", "real source outer result; actual opening read and real gate call", "source-page fault; actual gate result enters cold compaction source"],
    checkpointRecovery: ["actual source handoff with unread tail; one durable commit", "exact committed page fault without stop", "actual returned summary plus retained original canonical source", "new selected entry search/read tail; one checkpoint consumer; no repeated business calls"],
    uncommittedCompaction: ["first cold compaction actual opening read confirmed", "immediate exact page fault; require zero accepted/committed handoff", "retry identical public body once", "same target/work/original deadline; unique successor; actual new-entry tail read and one commit"],
    faultRace: "If the actual handoff/commit wins before the fault, fail this case. Never undo a commit or invent an uncommitted state.",
    zeroRisk: zeroRiskSteps(), guarantees: "Project-controlled dispatch and state only. Platform activities and platform tokens unknown." };
}

async function runTransition(name: TransitionCase, model: string, output?: string) {
  await runContinuityLive({ action: "run", case: "ordinary-recovery", mode: "automatic", model, output }, {
    caseName: name, task: fixture => transitionTask(fixture, name),
    async afterOpening(context) {
      const { report, fixture } = context;
      report.limitations = ["Zero Risk is observed separately with human Send/Sent", "one uncommitted successor only; concurrent and lost-prepare-receipt matrix remains separate"];
      const before = structuredClone(context.record());
      const originalPage = await context.pageIdentity();
      await context.crashOwnedPage(originalPage, "compaction-source-preparation");
      context.appendResult(context.gate, JSON.stringify({ gate: "outer-result-settled", source_call_id: context.source.call_id,
        instruction: "The accepted task remains unfinished. Follow its checkpoint policy during compaction, and never repeat either historical work call." }));
      const control = COMPACT_PROMPT + "\n" + (name === "checkpoint-recovery"
        ? "Use the actual compaction context navigation entry to read the source log opening page at offset zero. Do not search or read CONTINUITY_TAIL_TARGET. Preserve the unread source tail and accepted task as remaining work for the next ordinary consumer. Do not guess or include tailValue. Submit the real MCP handoff once."
        : "Use the actual compaction context entry to read the source log opening page at offset zero first. After that read has returned, search CONTINUITY_TAIL_TARGET, then use reads:[{read_ref,cursor:read_cursor}] to read the exact context-text-batch-v1 body selected by metadata.items[].body_content_index and put the observed tailValue in the summary. The value is beyond the search snippet. Submit the real MCP handoff once, after the tail read returns. No business tools.");
      const compact = compactionBody(context.body, control), encoded = JSON.stringify(compact);
      report.compaction = { publicBodyBytes: Buffer.byteLength(encoded), publicBodyDigest: digest(encoded), publicContract: "responses/memento/standalone_turn",
        controlBytes: Buffer.byteLength(control), controlDigest: digest(control),
        originalPage, sourceJournal: summarizeTransitionJournal(before), responses: [], handoffEvents: [] };
      const restoreHandoff = observeCompactionHandoff(context.broker, before.thread, event => {
        report.compaction.handoffEvents.push(event); context.save();
      });
      try {
      const observeResponse = (envelope: Row, phase: string) => observeCheckpointResponse(envelope, structure => {
        report.compaction.responses.push({ sequence: report.compaction.responses.length + 1, phase, ...structure }); context.save();
      });
      context.phase(name === "checkpoint-recovery" ? "compaction-checkpoint" : "compaction-first");
      let faultRecord: RecoveryThreadRecord | undefined, rejectedRecord: RecoveryThreadRecord | undefined;
      let preCommitRecord: RecoveryThreadRecord | undefined, preCommitRead: ReadEvidence | undefined;
      let crash: Promise<void> | undefined;
      let crashFailure: unknown;
      if (name === "uncommitted-compaction") context.onConfirmedRead(row => {
        if (row.phase !== "compaction-first" || !row.exact || row.start !== 0 || crash) return;
        faultRecord = structuredClone(context.record());
        assert.equal(Object.keys(faultRecord.checkpoints).length, 0, "故障读后已经提交，不是未提交 case");
        const work = compactWork(faultRecord);
        assert.equal(work.attempts.at(-1)?.stage, "accepted", "真实压缩 Send 未核清");
        assert.ok(work.retryBudget?.deadlineAt, "缺少原真实截止时间");
        crash = context.pageIdentity().then(async page => { report.compaction.firstPage = page; await context.crashOwnedPage(page, "uncommitted-compaction"); });
        void crash.catch(error => { crashFailure = error; });
      });
      let compactEnvelope = await context.request(JSON.parse(encoded), name === "uncommitted-compaction");
      observeResponse(compactEnvelope, name === "checkpoint-recovery" ? "compaction-checkpoint" : "compaction-first");
      context.onConfirmedRead();
      if (name === "uncommitted-compaction") {
        assert.ok(crash, "未观测到真实压缩开头读取；没有注入故障"); await crash; if (crashFailure) throw crashFailure;
        rejectedRecord = structuredClone(context.record());
        report.compaction.faultJournal = summarizeTransitionJournal(faultRecord!);
        report.compaction.rejectedJournal = summarizeTransitionJournal(rejectedRecord);
        assert.equal(Object.keys(rejectedRecord.checkpoints).length, 0, "handoff 已经成功，不能冒充未提交压缩");
        assert.ok(compactEnvelope.harnessHttpStatus || compactEnvelope.status !== "completed", "第一压缩意外成功，不能冒充失页重试");
        const retry = JSON.parse(encoded); report.compaction.retryBodyDigest = digest(JSON.stringify(retry));
        context.phase("compaction-retry");
        context.onConfirmedRead(row => {
          if (row.phase !== "compaction-retry" || !row.exact || row.start !== 0 || row.tail || preCommitRecord) return;
          // Production drops retryBudget at commit. Observe its real predecessor state at
          // the supported-transport head return, before the model can submit the tail handoff.
          preCommitRecord = structuredClone(context.record()); preCommitRead = structuredClone(row);
          report.compaction.preCommitJournal = summarizeTransitionJournal(preCommitRecord);
          report.compaction.preCommitRead = preCommitRead; context.save();
        });
        try { compactEnvelope = await context.request(retry); observeResponse(compactEnvelope, "compaction-retry"); } finally { context.onConfirmedRead(); }
      }
      const { summary } = actualCheckpoint(compactEnvelope);
      const committed = structuredClone(context.record());
      report.compaction.commitJournal = summarizeTransitionJournal(committed);
      report.compaction.summaryBytes = Buffer.byteLength(summary); report.compaction.summaryDigest = digest(summary);
      assert.equal(Object.keys(committed.checkpoints).length, 1, "缺少唯一真实 commit");
      let oldTarget: string, newTarget: string, answer: string;
      if (name === "checkpoint-recovery") {
        assert.ok(!summary.includes(fixture.tailValue), "checkpoint 泄漏了未读答案");
        const committedPage = await context.pageIdentity(); report.compaction.committedPage = committedPage;
        await context.crashOwnedPage(committedPage, "after-checkpoint-commit");
        context.phase("checkpoint-continuation");
        const final = await context.request(checkpointContinuationBody(context.body, compactEnvelope));
        assert.equal(final.status, "completed"); assert.equal(final.end_turn, true);
        for (const call of final.output.filter((item: Row) => item.type === "function_call")) report.calls.push({ phase: "checkpoint-continuation", callId: call.call_id, name: call.name });
        report.finalResponse = summarizeContinuityFinalResponse(final, context.redact); context.save();
        const text = extractContinuityFinalResponseText(final);
        answer = JSON.parse(text.trim()).tailValue; report.syntheticAnswer = { tailValue: answer };
        oldTarget = committedPage.targetId; newTarget = (report.newPage = await context.pageIdentity()).targetId;
      } else {
        oldTarget = report.compaction.firstPage.targetId; newTarget = (report.newPage = await context.pageIdentity()).targetId;
        answer = summary.includes(fixture.tailValue) ? fixture.tailValue : "";
      }
      const after = structuredClone(context.record()); report.compaction.finalJournal = summarizeTransitionJournal(after);
      report.checks = inspectTransitionEvidence({ case: name, fixture, reads: report.reads, calls: report.calls, results: report.results,
        plans: report.plans, oldTarget, newTarget, before, after, faultRecord, rejectedRecord, preCommitRecord, preCommitRead, summary, answer,
        compactBodyDigest: digest(encoded), retryBodyDigest: report.compaction.retryBodyDigest });
      const dispatched = report.events.filter((event: Row) => event.kind === "actual-business-dispatch");
      if (dispatched.length !== 2 || dispatched.some((event: Row) => ![SOURCE, GATE].includes(event.name))) report.checks.failures.push("真实 adapter 派发总数不为两个来源调用");
      report.checks.passed = report.checks.failures.length === 0; context.save();
      } finally { restoreHandoff(); }
    },
  });
}

/** Real original manual control; never DOM/CDP/button automation. Boundary fixture is small. */
async function runZeroRiskBoundary(boundary: "active" | "ended", model: string, selectedOutput?: string) {
  const inspected = await checkContinuityDev(); assert.ok(inspected.report.readyToAttempt, inspected.report.blockers.join("；"));
  assert.equal(inspected.report.config.mode, "zero-risk");
  const { paths } = inspected, config = inspected.config!, descriptor = inspected.descriptor!;
  const route = requireChatGptWebModelRoute(model, config); assert.equal(route.interactionMode, "manual", "人工边界必须使用 Zero Risk 模型入口");
  const output = resolve(selectedOutput ?? join(".dev-workflows/unified-task-continuity/evidence/runs", `zero-risk-${boundary}-${randomUUID()}`));
  assert.ok(!existsSync(output)); mkdirSync(output, { recursive: true, mode: 0o700 });
  const runtime = mkdtempSync(join(tmpdir(), "unified-manual-boundary-")), continuity = join(runtime, "session-continuity");
  const previousConfigHome = process.env.CODEX_CHATGPT_WEB_HOME; process.env.CODEX_CHATGPT_WEB_HOME = paths.home;
  const secrets = new Set([config.controlToken, descriptor.control.token].filter(Boolean));
  const report: Row = { schema: "unified-continuity-zero-risk-boundary/v1", boundary, status: "running", boundaryOnly: true,
    automaticSend: false, configChanged: false, model, effort: route.adapterEffort, preflight: inspected.report, startedAt: new Date().toISOString(), pages: [], events: [], calls: [] };
  const save = () => writeFileSync(join(output, "boundary.json"), redactContinuityEvidence(JSON.stringify(report, null, 2) + "\n", secrets), { mode: 0o600 });
  let phase = "ordinary", session: ChatGptTurnSession | undefined;
  const controller = new AbortController(), interrupt = () => controller.abort(new Error("人工验收停止"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const heartbeat = setInterval(() => console.log(`Zero Risk ${boundary}：${phase}。请沿 Launcher 原 Copy/Send/Sent 流程操作。`), 30_000);
  let transport: Awaited<ReturnType<typeof startDevChatTransport>> | undefined;
  const manual: ChatGptZeroRiskManualControl = {
    async start(path, activity) {
      collectContinuityCapabilities(activity, secrets);
      for (const token of activity.prompt.match(/\b(?:turn|control|handoff|compaction|context)_[A-Za-z0-9_-]{16,}\b/g) ?? []) secrets.add(token);
      const lease = await startLauncherManualTurn(path, activity);
      const prompt = lease.reused ? activity.resumePrompt : activity.prompt; assert.ok(prompt);
      report.pages.push({ phase, tabId: lease.tabId, reused: lease.reused, traceDigest: digest(activity.traceId), helperPid: activity.helperPid,
        promptBytes: Buffer.byteLength(prompt), promptTokens: estimateTokens(prompt, model), promptDigest: digest(prompt),
        selectedPlanDigest: lease.selectedPlanId ? digest(lease.selectedPlanId) : null, sentConfirmationRequired: lease.sentConfirmationRequired });
      save(); console.log("当前真实提示已由 Launcher 显示。请人工 Copy、Send，然后点击 Sent。脚本不会点击按钮。"); return lease;
    },
    async waitSent(path, owner, options) { const receipt = await waitForLauncherManualSent(path, owner, options);
      report.events.push({ phase, kind: "human-Sent", traceDigest: digest(owner.traceId), sentAt: receipt.sentAt, basis: "real Launcher human confirmation" }); save(); return receipt; },
    waitTerminal: waitForLauncherManualTerminal, markStarted: markLauncherManualTurnStarted, end: endLauncherManualTurn, cancel: cancelLauncherManualTurn,
  };
  try {
    const prepared = await prepareContinuityDevProvider(providerConfig(config), paths, {
      continuityStateDirectory: continuity, lunaCheckpointStatePath: join(runtime, "luna.json"),
    });
    const provider = prepared.provider; report.providerCapability = continuityDevProviderEvidence(prepared); save();
    transport = await startDevChatTransport(config, paths.runtimePath);
    const broker = await callTurnBroker<Row>(config.brokerSocketPath, { method: "owner_status" });
    assert.ok(broker.protocolVersion >= 13 && broker.recoveryProtocol === 2); new ContinuityRegistrationStore(continuity).initialize();
    const task = boundary === "active"
      ? "This is an inert manual DEV boundary case. Invoke continuity_manual_gate({}) exactly once. After its actual result, invoke continuity_manual_hold({}) unless Native supplies a checkpoint instruction. Follow that real checkpoint instruction and submit the MCP handoff. Do not invoke any other business tool."
      : "This is an inert manual DEV boundary case. Do not invoke a business tool. Complete with exactly MANUAL_BOUNDARY_DONE.";
    const source = createLiveRequestBody({ case: "mcp-partial", bodies: [], expected: { fragments: [], priority: "", call_pairs: [] }, task },
      { purpose: "ordinary", model, cwd: process.cwd(), threadId: `dev_manual_${randomUUID()}`, turnId: `dev_manual_turn_${randomUUID()}` });
    const body: Row = { ...source, tools: boundary === "active" ? ["continuity_manual_gate", "continuity_manual_hold"].map(name => ({ type: "function", name,
      description: "An inert manual boundary fixture; empty parameters only.", parameters: { type: "object", properties: {}, additionalProperties: false } })) : [] };
    body.instructions = "Follow the isolated manual fixture task. During compaction use the real MCP handoff. Never repeat a settled historical business call.";
    const factory: NonNullable<Parameters<typeof responseRequest>[2]> = () => {
      const adapter = createChatGptWebAdapter(provider, { broker: transport!.broker, zeroRiskManualControl: manual }), originalRun = adapter.runTurn!;
      return { ...adapter, async runTurn(parsed, request, emit) { const capture = () => { if (Number.isSafeInteger(parsed._continuityHistoryRevision))
          session = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`) ?? session; };
        await originalRun.call(adapter, parsed, request, event => { capture(); emit(event); }); capture(); } };
    };
    const request = async (raw: Row) => {
      const response = await responseRequest(new Request("http://unified-continuity.dev/v1/responses", { method: "POST", headers: { "content-type": "application/json",
        "x-codex-turn-metadata": source.client_metadata["x-codex-turn-metadata"] }, body: JSON.stringify(raw), signal: controller.signal }), config, factory,
        { rememberState: false, onTurnIdentity: () => controller.signal, onAdapterEvent: event => {
          if (event.type === "tool_call_start") report.calls.push({ phase, callId: event.id, name: event.name });
          if (["done", "error", "incomplete"].includes(event.type)) report.events.push({ phase, kind: "adapter-outcome", type: event.type }); save(); } });
      const result = await response.json() as Row;
      if (phase === "compaction") observeCheckpointResponse(result, structure => {
        report.compactionResponses ??= []; report.compactionResponses.push({ sequence: report.compactionResponses.length + 1, phase, httpStatus: response.status, ...structure }); save();
      });
      assert.ok(response.ok, `真实 manual Responses 失败：${JSON.stringify({ httpStatus: response.status, ...summarizeHarnessResponse(result) })}`); return result;
    };
    const ordinary = await request(body);
    if (boundary === "active") {
      const call = ordinary.output?.find((item: Row) => item.type === "function_call"); assert.equal(call?.name, "continuity_manual_gate");
      assert.equal(ordinary.output.filter((item: Row) => item.type === "function_call").length, 1);
      body.input.push(...ordinary.output, { type: "function_call_output", call_id: call.call_id, output: "Inert outer gate settled. Request the next Native boundary and follow any real checkpoint instruction." });
    } else { assert.equal(ordinary.status, "completed"); assert.equal(ordinary.end_turn, true); body.input.push(...ordinary.output);
      assert.ok(session, "缺少真实普通 source session"); await session.physicalSettlement; }
    phase = "compaction"; const compact = await request(compactionBody(body)); const { summary } = actualCheckpoint(compact);
    const ref = session?.runtime.continuityBinding?.recovery; assert.ok(ref); const record = recoveryRecord(ref); collectContinuityCapabilities(record, secrets);
    report.journal = summarizeTransitionJournal(record); report.summaryBytes = Buffer.byteLength(summary); report.summaryDigest = digest(summary);
    const failures: string[] = [];
    if (Object.keys(record.checkpoints).length !== 1) failures.push("没有唯一真实 checkpoint");
    if (report.pages.some((page: Row) => !page.sentConfirmationRequired)) failures.push("人工 Sent 要求丢失");
    if (report.pages.length !== (boundary === "active" ? 1 : 2)) failures.push("手工活动数不符合活动/已结束边界");
    if (report.events.filter((event: Row) => event.kind === "human-Sent").length !== report.pages.length) failures.push("缺少每个真实新活动的人工 Sent");
    if (report.calls.length !== (boundary === "active" ? 1 : 0) || report.calls.some((call: Row) => call.name !== "continuity_manual_gate")) failures.push("手工边界业务调用被重复或新增");
    report.checks = { passed: failures.length === 0, failures }; report.status = report.checks.passed ? "passed" : "failed";
    report.limits = "This proves only the manual active/ended compaction boundary. Large source navigation, manual fault loss and checkpoint recovery are not covered.";
  } catch (error) {
    try { const ref = session?.runtime.continuityBinding?.recovery; if (ref) collectContinuityCapabilities(recoveryRecord(ref), secrets); } catch { /* Preserve the original failure. */ }
    report.status = "failed"; report.error = error instanceof Error ? error.message : String(error);
  }
  finally {
    try { await closeChatGptBrowserWorkers(); } catch (error) { report.status = "failed"; report.cleanupError = error instanceof Error ? error.message : String(error); }
    try { await transport?.close(); } catch (error) { report.status = "failed"; report.transportCloseError = error instanceof Error ? error.message : String(error); }
    // Manual physical targets are intentionally private. No public exact destroyed receipt
    // is available here, so retain this private operational journal even after success.
    report.privateRuntime = { directory: runtime, retained: true, cleanupConfirmed: false, evidenceCopied: false,
      reason: "manual physical cleanup not observable through public control API; do not erase unsettled or unknown facts" };
    clearInterval(heartbeat); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    if (previousConfigHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = previousConfigHome;
    report.finishedAt = new Date().toISOString(); save();
  }
  console.log(redactContinuityEvidence(JSON.stringify({ status: report.status, evidence: join(output, "boundary.json"), failures: report.checks?.failures ?? [], error: report.error ?? null }, null, 2), secrets));
  if (report.status !== "passed") process.exitCode = 1;
}

export function zeroRiskSteps() {
  return { preparation: "Coordinator selects DEV Zero Risk and obtains that mode's existing Verify runtime evidence; no script changes configuration.",
    commands: ["bun scripts/validate-unified-task-continuity-transitions.ts run-zero-risk --boundary=active --mode=zero-risk --model=chatgpt-web/zero-risk", "bun scripts/validate-unified-task-continuity-transitions.ts run-zero-risk --boundary=ended --mode=zero-risk --model=chatgpt-web/zero-risk"],
    active: ["Human sends an inert read-only task that requests one real tool. Use Copy, human Send and human Sent.",
      "At the actual pending fixture gate, the boundary runner requests public compaction and supplies the real outer result. Wait for the existing activity's MCP compaction/handoff.",
      "If Launcher publishes a new manual activity, record its tab and selected plan. Human Copy/Send/Sent each actual new prompt. Never programmatically click."],
    ended: ["Human sends an inert short no-tool task with Copy/Send/Sent; wait for actual completed reply and physical settlement.",
      "The runner requests public compaction. Record a new manual activity, human Send/Sent and real MCP handoff. A completed activity must not be sent automatically."],
    observer: "observe-zero-risk reads only the real existing activity's human Sent receipt. Supply its actual trace ID and helper PID from the current runner, not an invented owner. It does not register, send, start, end or cancel any activity.",
    limits: "The read-only public manual API does not enumerate tab/plan/start/handoff. Record those from the actual runner/Launcher. This Sent observer alone never marks a Zero Risk case passed. No manual CDP target mapping or page fault is added." };
}

export function parseTransitionArgs(args: string[]) {
  const [action = "check", ...options] = args;
  if (["check", "--check-only", "plan"].includes(action)) { assert.equal(options.length, 0); return { action: action === "plan" ? "plan" : "check" } as const; }
  const value = (key: string) => options.find(option => option.startsWith(`${key}=`))?.slice(key.length + 1);
  const allowed = action === "observe-zero-risk" ? ["--trace", "--helper-pid", "--output", "--timeout-ms"] : action === "run-zero-risk" ? ["--boundary", "--mode", "--model", "--output"] : ["--case", "--mode", "--model", "--output"];
  assert.ok(options.every(option => allowed.some(key => option.startsWith(`${key}=`))) && allowed.every(key => options.filter(option => option.startsWith(`${key}=`)).length <= 1), "参数未知或重复");
  if (action === "run-zero-risk") {
    assert.ok(["active", "ended"].includes(value("--boundary") ?? "") && value("--mode") === "zero-risk" && value("--model"), "人工边界需要 --boundary=active|ended、--mode=zero-risk、--model=");
    assert.ok(!value("--model")!.startsWith("chatgpt-web-continuity/"), "旧模式已删除");
    return { action: "run-zero-risk", boundary: value("--boundary") as "active" | "ended", model: value("--model")!, output: value("--output") } as const;
  }
  if (action === "observe-zero-risk") {
    const trace = value("--trace"), helperPid = Number(value("--helper-pid")), timeoutMs = Number(value("--timeout-ms") ?? "300000");
    assert.ok(trace && /^[A-Za-z0-9_.:@+-]{1,256}$/.test(trace) && Number.isSafeInteger(helperPid) && helperPid > 0 && value("--output"), "需要真实 --trace=、--helper-pid= 和新 --output=");
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30 * 60_000);
    return { action: "observe-zero-risk", trace, helperPid, output: value("--output")!, timeoutMs } as const;
  }
  assert.ok(action === "run" && TRANSITION_CASES.includes(value("--case") as TransitionCase) && value("--mode") === "automatic" && value("--model"), "run 需要 --case=checkpoint-recovery|uncommitted-compaction、--mode=automatic、--model=；Zero Risk 必须人工 Send/Sent");
  assert.ok(!value("--model")!.startsWith("chatgpt-web-continuity/"), "旧模式已删除");
  return { action: "run", case: value("--case") as TransitionCase, model: value("--model")!, output: value("--output") } as const;
}

async function main() {
  const args = parseTransitionArgs(process.argv.slice(2));
  if (args.action === "plan") { console.log(JSON.stringify(transitionsPlan(), null, 2)); return; }
  if (args.action === "check") { const { report } = await checkContinuityDev(); console.log(JSON.stringify(report, null, 2)); if (!report.readyToAttempt) process.exitCode = 1; return; }
  if (args.action === "run") { await runTransition(args.case, args.model, args.output); return; }
  if (args.action === "run-zero-risk") { await runZeroRiskBoundary(args.boundary, args.model, args.output); return; }
  if (args.action !== "observe-zero-risk") throw new Error("未知观察命令");
  const inspected = await checkContinuityDev(); assert.ok(inspected.report.readyToAttempt, inspected.report.blockers.join("；"));
  assert.equal(inspected.report.config.mode, "zero-risk", "观察器仅用于现有 DEV Zero Risk，不切换模式");
  process.kill(args.helperPid, 0);
  const output = resolve(args.output); assert.ok(!existsSync(output)); mkdirSync(output, { recursive: true, mode: 0o700 });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const heartbeat = setInterval(() => console.log("只读观察：等待用户人工 Send 和 Sent。观察器不会发送消息。"), 30_000);
  const report: Row = { schema: "unified-continuity-zero-risk-Sent-observation/v1", status: "observing", humanSendRequired: true,
    automaticSend: false, activityRegistered: false, helperPid: args.helperPid, traceDigest: digest(args.trace), startedAt: new Date().toISOString(), acceptancePassed: false };
  try { const receipt = await waitForLauncherManualSent(inspected.paths.descriptorPath, { traceId: args.trace, helperPid: args.helperPid }, { abortSignal: controller.signal, timeoutMs: 30_000 });
    report.status = "human-Sent-observed"; report.sentAt = receipt.sentAt; report.basis = "real Launcher human-confirmation receipt";
  } catch (error) { report.status = "failed"; report.error = error instanceof Error ? error.name : "observer-error"; process.exitCode = 1; }
  finally { clearInterval(heartbeat); clearTimeout(timer); report.finishedAt = new Date().toISOString(); writeFileSync(join(output, "sent-observation.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); }
  console.log(JSON.stringify(report, null, 2));
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
