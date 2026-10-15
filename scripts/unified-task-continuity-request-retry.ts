import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CONTINUITY_RECOVERY_RETRY_WINDOW_MS, MAX_CONTINUITY_RECOVERY_RETRIES, type RecoveryThreadRecord } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { parseRequest } from "../src/responses/parser";

type Row = Record<string, any>;
const digest = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value) ?? "undefined").digest("hex");
const responseCodes = new Set([
  "continuity_unverified", "continuity_execution_unsettled", "continuity_context_missing", "continuity_result_conflict",
  "continuity_replay_unavailable", "continuity_legacy_unproven", "continuity_stopped", "continuity_retry_exhausted",
  "continuity_session_lost", "continuity_source_unproven", "continuity_manual_handoff_required", "continuity_configuration_conflict",
  "continuity_input_limit", "continuity_resource_capacity", "task_update_unacknowledged", "task_update_driver_changed",
]);

/** Unknown response values can contain arbitrary user text or capabilities. Keep only their type and digest. */
export function summarizeHarnessResponse(envelope: Row): Row {
  const field = (name: string, present: boolean, value: unknown, valid: boolean) => ({
    [`${name}Present`]: present, [`${name}Type`]: !present ? "absent" : value === null ? "null" : typeof value,
    [name]: present && valid ? value : null,
    ...(present && !valid ? { [`invalid${name[0]!.toUpperCase()}${name.slice(1)}Digest`]: digest(value) } : {}),
  });
  return {
    ...field("outcome", Object.hasOwn(envelope, "status"), envelope.status, ["failed", "completed", "incomplete", "in_progress", "queued", "cancelled"].includes(envelope.status)),
    ...field("endTurn", Object.hasOwn(envelope, "end_turn"), envelope.end_turn, typeof envelope.end_turn === "boolean" || envelope.end_turn === null),
    ...field("errorCode", Boolean(envelope.error && Object.hasOwn(envelope.error, "code")), envelope.error?.code,
      typeof envelope.error?.code === "string" && responseCodes.has(envelope.error.code) || envelope.error?.code === null),
    ...field("retryable", Object.hasOwn(envelope, "retryable"), envelope.retryable, typeof envelope.retryable === "boolean" || envelope.retryable === null),
    errorDigest: Object.hasOwn(envelope, "error") ? digest(envelope.error) : null,
  };
}
export interface HarnessRequestSnapshot {
  record?: RecoveryThreadRecord;
  logicalWorkId?: string;
  sends: number;
  dispatches: number;
  expectedResults: ReadonlyArray<{ callId: string; firstResultDigest: string }>;
}
export interface ExactHarnessRequest { body: string; headers: Readonly<Record<string, string>>; signal: AbortSignal }
export interface HarnessRequestResult { response: Response; envelope: Row }
export interface HarnessRequestOptions extends ExactHarnessRequest {
  mode: string; phase: string; allowFailure: boolean;
  snapshot(): HarnessRequestSnapshot;
  send(exact: ExactHarnessRequest): Promise<HarnessRequestResult>;
  record(evidence: Row): void;
}

function retryDecision(options: HarnessRequestOptions, envelope: Row, before?: HarnessRequestSnapshot, after?: HarnessRequestSnapshot) {
  const refuse = (reason: string) => ({ allowed: false, reason });
  if (options.mode !== "automatic" || !["opening", "continuation"].includes(options.phase) || options.allowFailure) return refuse("request mode or phase is excluded");
  if (options.signal.aborted) return refuse("original signal aborted");
  if (envelope.status !== "failed" || envelope.error?.code !== "continuity_session_lost"
    || !Object.hasOwn(envelope, "retryable") || envelope.retryable !== true) return refuse("public response does not explicitly authorize this retry");
  if (!before?.record || !after?.record || !before.logicalWorkId || !after.logicalWorkId) return refuse("durable source observation unavailable");
  const prior = before.record, current = after.record, source = prior.works[before.logicalWorkId], work = current.works[after.logicalWorkId];
  if (!source || !work || before.logicalWorkId !== after.logicalWorkId || prior.currentWorkId !== before.logicalWorkId || current.currentWorkId !== after.logicalWorkId
    || prior.thread !== current.thread || prior.scope !== current.scope || !isDeepStrictEqual(prior.owner, current.owner)
    || source.purpose !== "ordinary" || work.purpose !== "ordinary" || source.state !== "active" || work.state !== "active"
    || source.stopReason || work.stopReason || prior.legacyUnproven || current.legacyUnproven || current.pendingPreparation
    || source.instructionIdentity !== work.instructionIdentity || source.workPayloadDigest !== work.workPayloadDigest
    || source.workLineageId !== work.workLineageId || source.acceptedTaskRevision !== work.acceptedTaskRevision
    || prior.epoch !== current.epoch || prior.historyRevision !== current.historyRevision) return refuse("original active ordinary work changed or is unproven");
  if (!Number.isSafeInteger(before.sends) || before.sends <= 0 || before.sends !== after.sends
    || !Number.isSafeInteger(before.dispatches) || before.dispatches <= 0 || before.dispatches !== after.dispatches) return refuse("first request sent or dispatched new work, or original counters are unproven");
  const accepted = source.attempts.at(-1), latest = work.attempts.at(-1);
  if (!accepted || !latest || source.attempts.length !== work.attempts.length || accepted.attempt !== latest.attempt || accepted.epoch !== latest.epoch
    || accepted.sendEvidence?.status !== "accepted" || latest.sendEvidence?.status !== "accepted"
    || !isDeepStrictEqual(accepted.sendEvidence, latest.sendEvidence) || !["accepted", "interrupted-settled"].includes(latest.stage)
    || !source.attempts.every(attempt => attempt.dispatchProtocolComplete && attempt.sendEvidence?.status !== "possible")
    || !work.attempts.every(attempt => attempt.dispatchProtocolComplete && attempt.sendEvidence?.status !== "possible")) return refuse("original accepted Send or complete execution cannot be proved");
  const expected = before.expectedResults;
  if (!expected.length || !isDeepStrictEqual(expected, after.expectedResults)
    || !isDeepStrictEqual(Object.keys(prior.calls).sort(), Object.keys(current.calls).sort())
    || Object.values(current.calls).some(call => call.state !== "settled" || !call.firstResultDigest)
    || expected.length !== Object.keys(current.calls).length
    || expected.some(result => current.calls[result.callId]?.firstResultDigest !== result.firstResultDigest
      || prior.calls[result.callId]?.firstResultDigest !== undefined && prior.calls[result.callId]?.firstResultDigest !== result.firstResultDigest)) return refuse("original result set or first digests are unsettled or changed");
  try {
    const body = JSON.parse(options.body), parsed = parseRequest(body);
    const metadata = body.client_metadata?.["x-codex-turn-metadata"];
    const native = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    if (parsed._compactionRequest || native?.request_kind === "compaction" || !Array.isArray(body.input)) return refuse("actual public body is not ordinary");
    const results = body.input.filter((item: Row) => item?.type === "function_call_output" || item?.type === "custom_tool_call_output");
    const digests = results.map((item: Row) => ({ callId: item.call_id, firstResultDigest: recoveryResultDigest(item) }));
    if (!isDeepStrictEqual(digests, expected)) return refuse("serialized body does not contain the original exact results");
  } catch { return refuse("actual public body cannot be proved ordinary"); }
  const budget = work.retryBudget, original = source.retryBudget, now = Date.now();
  if (!budget || !original || !Number.isSafeInteger(budget.attempts) || budget.attempts < 1 || budget.attempts >= MAX_CONTINUITY_RECOVERY_RETRIES + 1
    || budget.attempts !== original.attempts || !Number.isSafeInteger(budget.startedAt) || budget.startedAt > now
    || now - budget.startedAt > CONTINUITY_RECOVERY_RETRY_WINDOW_MS || budget.deadlineAt !== original.deadlineAt
    || budget.deadlineAt !== undefined && now >= budget.deadlineAt
    || original.lastFailureAt !== undefined && budget.startedAt !== original.startedAt
    || original.lastFailureAt === undefined && budget.startedAt !== original.startedAt && budget.startedAt !== budget.lastFailureAt) return refuse("original durable retry budget or deadline is exhausted or changed");
  return { allowed: true, reason: "explicit retryable failure with unchanged accepted work and settled exact results" };
}

/** White-listed durable facts only. Never persist a lease, authorization or prompt. */
export function summarizeHarnessRequestSnapshot(snapshot: HarnessRequestSnapshot | undefined) {
  if (!snapshot) return null;
  const record = snapshot.record, work = record && snapshot.logicalWorkId ? record.works[snapshot.logicalWorkId] : undefined;
  return { sends: snapshot.sends, dispatches: snapshot.dispatches,
    expectedResults: snapshot.expectedResults.map(result => ({ callDigest: digest(result.callId), firstResultDigest: result.firstResultDigest })),
    durable: !record || !work ? null : { version: record.version, epoch: record.epoch, historyRevision: record.historyRevision,
      threadDigest: digest(record.thread), ownerDigest: digest(record.owner.id), workDigest: digest(work.logicalWorkId),
      currentWorkDigest: record.currentWorkId ? digest(record.currentWorkId) : null, purpose: work.purpose, state: work.state,
      stopped: work.state === "stopped", stopReason: work.stopReason ?? null, retryBudget: work.retryBudget ? {
        attempts: work.retryBudget.attempts, startedAt: work.retryBudget.startedAt,
        deadlineAt: work.retryBudget.deadlineAt ?? null, lastFailureAt: work.retryBudget.lastFailureAt ?? null } : null,
      effectiveDeadlineAt: work.retryBudget ? Math.min(work.retryBudget.deadlineAt ?? Infinity, work.retryBudget.startedAt + CONTINUITY_RECOVERY_RETRY_WINDOW_MS) : null,
      attempts: work.attempts.map(attempt => ({ attempt: attempt.attempt, epoch: attempt.epoch, stage: attempt.stage,
        writerRetired: attempt.writerRetired, dispatchProtocolComplete: attempt.dispatchProtocolComplete,
        sendEvidencePresent: attempt.sendEvidence !== undefined, sendStatus: attempt.sendEvidence?.status ?? null,
        sendAuthorizationDigest: attempt.sendEvidence ? digest(attempt.sendEvidence.authorizationId) : null,
        sendIdentityDigest: attempt.sendEvidence?.identityDigest ?? null })),
      calls: Object.values(record.calls).map(call => ({ callDigest: digest(call.callId), state: call.state, firstResultDigest: call.firstResultDigest ?? null })) } };
}

/** Shared actual Responses boundary. The body is serialized exactly once by the caller. */
export async function runContinuityHarnessRequest(options: HarnessRequestOptions): Promise<HarnessRequestResult> {
  const exact = Object.freeze({ body: options.body, headers: Object.freeze({ ...options.headers }), signal: options.signal });
  const snapshot = () => { try { return structuredClone(options.snapshot()); } catch { return undefined; } };
  const frozenOptions = { ...options, ...exact };
  let originalBefore: HarnessRequestSnapshot | undefined;
  let firstFailure: HarnessRequestResult | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = snapshot(), startedAt = Date.now();
    originalBefore ??= before;
    if (attempt === 2) {
      const finalDecision = retryDecision(frozenOptions, firstFailure!.envelope, originalBefore, before);
      if (!finalDecision.allowed) {
        options.record({ attempt: 1, phase: options.phase, observation: "before-retry-recheck", retryAttempted: false,
          retryDecision: finalDecision, beforeRetry: summarizeHarnessRequestSnapshot(before) });
        return firstFailure!;
      }
    }
    const result = await options.send(exact), after = snapshot();
    const decision = attempt === 1 ? retryDecision(frozenOptions, result.envelope, before, after) : { allowed: false, reason: "one additional request has already been spent" };
    const evidence = { attempt, phase: options.phase, startedAt, finishedAt: Date.now(), bodyDigest: digest(exact.body),
      bodyBytes: Buffer.byteLength(exact.body), headersDigest: digest(exact.headers), httpStatus: result.response.status,
      ...summarizeHarnessResponse(result.envelope),
      before: summarizeHarnessRequestSnapshot(before), after: summarizeHarnessRequestSnapshot(after), retryAttempted: attempt === 2,
      retryDecision: decision };
    options.record(evidence); // Persist the original response before any retry effect.
    if (!decision.allowed) return result;
    firstFailure = result;
    const fresh = snapshot(), rechecked = retryDecision(frozenOptions, result.envelope, originalBefore, fresh);
    if (!rechecked.allowed) { options.record({ ...evidence, observation: "before-retry-recheck", retryDecision: rechecked, beforeRetry: summarizeHarnessRequestSnapshot(fresh) }); return result; }
    options.record({ ...evidence, observation: "retry-authorized", retryAuthorized: true, beforeRetry: summarizeHarnessRequestSnapshot(fresh) });
  }
  throw new Error("bounded harness request exhausted without response");
}
