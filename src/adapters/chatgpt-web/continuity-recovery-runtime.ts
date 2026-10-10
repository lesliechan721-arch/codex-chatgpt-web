import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { parseRequest } from "../../responses/parser";
import { canonicalJson } from "./canonical-json";
import { continuityError } from "./continuity-errors";
import { ContinuityRecoveryStore, continuityProcessInstance, type RecoveryThreadRecord, type RecoveryWorkRecord } from "./continuity-recovery-store";
import type { ContinuityRecoveryIdentity } from "./continuity-contract";
import type { BrokerToolRequest } from "./turn-broker";

/** Passed only through authenticated local owner registration, never Native invocation input. */
export interface RuntimeRecoveryReference {
  directory: string;
  thread: string;
  logicalWorkId: string;
  attempt: number;
  ownerId?: string;
}
export interface RuntimeRecoveryFinalReceipt {
  readonly directory: string;
  readonly thread: string;
  readonly logicalWorkId: string;
  readonly workLineageId: string;
  readonly terminalReceiptId: string;
  readonly terminalDigest: string;
}
const resultBodies = new Map<string, Map<string, Record<string, unknown>>>();
const resultBodyReferences = new Map<string, RuntimeRecoveryReference>();
const resultBodyOwner = continuityProcessInstance();
export function recoveryDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function recoveryResultDigest(item: Record<string, unknown>): string {
  return recoveryDigest(item.type === "tool_search_output"
    ? { type: item.type, call_id: item.call_id, status: typeof item.status === "string" ? item.status : null,
      tools: Array.isArray(item.tools) ? item.tools : [] }
    : { type: item.type, call_id: item.call_id, output: item.output ?? item.content ?? null });
}
export function recoveryStore(ref: RuntimeRecoveryReference): ContinuityRecoveryStore {
  return new ContinuityRecoveryStore(ref.directory);
}
export function recoveryRecord(ref: RuntimeRecoveryReference): RecoveryThreadRecord {
  const record = recoveryStore(ref).get(ref.thread);
  if (!record || record.legacyUnproven) throw continuityError("continuity_legacy_unproven");
  const work = record.works[ref.logicalWorkId];
  if (!work || !work.attempts.some(value => value.attempt === ref.attempt)) throw continuityError("continuity_source_unproven");
  return record;
}
export function assertRecoveryWriter(ref: RuntimeRecoveryReference): RecoveryThreadRecord {
  const record = recoveryRecord(ref);
  const work = record.works[ref.logicalWorkId]!;
  const attempt = work.attempts.find(value => value.attempt === ref.attempt)!;
  if (work.state === "stopped") throw continuityError("continuity_stopped");
  if (record.pendingPreparation) throw continuityError("continuity_unverified", "The prior input preparation is still being coordinated.");
  if ((ref.ownerId !== undefined && ref.ownerId !== record.owner.id) || record.currentWorkId !== ref.logicalWorkId || attempt.writerRetired
    || attempt.epoch !== record.epoch || attempt !== work.attempts.at(-1) || work.state === "completed") {
    throw continuityError("continuity_source_unproven", "An obsolete execution cannot write to the current recovery attempt.");
  }
  return record;
}
/** Every Broker entry uses this one boundary before returning calls to an outer executor. */
export function recordRecoveryDelivery(ref: RuntimeRecoveryReference, requests: Array<BrokerToolRequest & { operationId?: number }>): void {
  const record = assertRecoveryWriter(ref);
  if (!requests.length) return;
  const store = recoveryStore(ref);
  // Publish identities and delivery-possible in one atomic write. An interrupted return is
  // deliberately unknown, never proof that the outer executor did not receive the call.
  store.transact(ref.thread, { scope: record.scope, expectedVersion: record.version }, draft => {
    const work = draft.works[ref.logicalWorkId]!;
    const lineage = draft.lineages[work.workLineageId];
    if (!lineage) throw continuityError("continuity_context_missing");
    const newCalls = requests.filter(request => !draft.calls[request.callId]);
    const sequence = newCalls.length ? ++lineage.toolBatchHeadSequence : lineage.toolBatchHeadSequence;
    if (newCalls.length) lineage.batchMappings[`${ref.logicalWorkId}:${ref.attempt}:${sequence}`] = sequence;
    for (const request of requests) {
      const previous = draft.calls[request.callId];
      if (previous) {
        if (previous.logicalWorkId !== ref.logicalWorkId || previous.attempt !== ref.attempt
          || previous.state !== "delivery-possible") throw continuityError("continuity_source_unproven");
        continue;
      }
      draft.calls[request.callId] = {
        callId: request.callId, operationId: recoveryDigest([ref.logicalWorkId, ref.attempt, request.operationId ?? request.callId]),
        expectedResultType: request.wireName === "tool_search" ? "tool_search_output"
          : request.freeform ? "custom_tool_call_output" : "function_call_output",
        logicalWorkId: ref.logicalWorkId, workLineageId: work.workLineageId, attempt: ref.attempt,
        batchSequence: sequence, state: "delivery-possible",
      };
    }
  });
}
export function acceptRecoveryResults(ref: RuntimeRecoveryReference, rawResults: Iterable<Record<string, unknown>>): void {
  const items = [...rawResults];
  if (!items.length) return;
  const record = recoveryRecord(ref);
  const apply = (draft: RecoveryThreadRecord): void => {
    const lineage = draft.works[ref.logicalWorkId]!.workLineageId;
    for (const item of items) {
      const id = String(item.call_id);
      const call = draft.calls[id];
      if (!call || call.workLineageId !== lineage || item.type !== call.expectedResultType
        || !["delivery-possible", "settled"].includes(call.state)) throw continuityError("continuity_context_missing", "A result does not match an issued call and its expected type.");
      const digest = recoveryResultDigest(item);
      if (call.firstResultDigest && call.firstResultDigest !== digest) throw continuityError("continuity_result_conflict");
      call.firstResultDigest = digest;
      call.state = "settled";
    }
  };
  // Validate every echo, but do not write another version for the same first result.
  const checked = structuredClone(record);
  apply(checked);
  if (items.some(item => record.calls[String(item.call_id)]?.state !== "settled")) {
    recoveryStore(ref).transact(ref.thread, { scope: record.scope, expectedVersion: record.version }, apply);
  }
  const key = `${ref.directory}:${ref.thread}`;
  let bodies = resultBodies.get(key);
  if (!bodies) { bodies = new Map(); resultBodies.set(key, bodies); }
  resultBodyReferences.set(key, ref);
  for (const item of items) {
    const id = String(item.call_id);
    if (bodies.has(id)) continue;
    try {
      if (recoveryStore(ref).setResultBodyBytes(ref.thread, { scope: record.scope }, id,
        Buffer.byteLength(JSON.stringify(item)), resultBodyOwner)) bodies.set(id, structuredClone(item));
    } catch { /* Optional body retention cannot undo an already accepted terminal result. */ }
  }
}

/** Release optional bodies before checkpoint admission; durable first results remain intact. */
export function evictOptionalRecoveryResults(directory: string): void {
  for (const [key, ref] of resultBodyReferences) {
    if (ref.directory !== directory) continue;
    resultBodies.delete(key);
    const store = recoveryStore(ref);
    const record = store.get(ref.thread);
    const ids = Object.values(record?.calls ?? {}).filter(call => call.resultBodyOwner?.id === resultBodyOwner.id).map(call => call.callId);
    if (record && ids.length) store.releaseResultBodyBytes(ref.thread, { scope: record.scope }, ids, resultBodyOwner);
    // Keep the cleanup reference if the durable release throws; the next attempt can
    // remove the conservative charge even though its optional body was already freed.
    resultBodyReferences.delete(key);
  }
  new ContinuityRecoveryStore(directory).releaseExitedResultBodies();
}
export function recoveryCanonicalResults(parsed: CodexParsedRequest): Record<string, unknown>[] {
  const input = (parsed._rawBody as { input?: unknown[] })?.input;
  return (Array.isArray(input) ? input : []).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"
    && ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(String((item as Record<string, unknown>).type))));
}
/** Uses explicit chain coverage; unknown delivered calls cannot be hidden by a checkpoint. */
export function recoveryContext(parsed: CodexParsedRequest, ref: RuntimeRecoveryReference, checkpointId?: string): CodexParsedRequest {
  let record = recoveryRecord(ref);
  const work = record.works[ref.logicalWorkId]!;
  const lineage = record.lineages[work.workLineageId];
  if (!lineage || !record.works[lineage.rootLogicalWorkId]) throw continuityError("continuity_context_missing", "The accepted instruction predecessor chain is incomplete.");
  const chainWorks = Object.values(record.works).filter(value => value.workLineageId === work.workLineageId);
  for (const related of chainWorks) {
    if ((related.predecessorLogicalWorkId && !record.works[related.predecessorLogicalWorkId])
      || related.attempts.some(attempt => !attempt.dispatchProtocolComplete)) throw continuityError("continuity_context_missing", "The previous execution has no complete dispatch evidence.");
  }
  const calls = Object.values(record.calls).filter(call => call.workLineageId === work.workLineageId);
  const covered = new Set(checkpointId ? record.checkpoints[checkpointId]?.coveredCallIds ?? [] : []);
  const supplied = new Map<string, Record<string, unknown>>();
  for (const item of recoveryCanonicalResults(parsed)) {
    const id = String(item.call_id);
    if (covered.has(id) && record.calls[id]?.state === "settled") continue;
    if (supplied.has(id) && recoveryResultDigest(supplied.get(id)!) !== recoveryResultDigest(item)) throw continuityError("continuity_result_conflict");
    supplied.set(id, item);
  }
  const local = resultBodies.get(`${ref.directory}:${ref.thread}`);
  const missing: Record<string, unknown>[] = [];
  const accepts: Record<string, unknown>[] = [];
  for (const call of calls) {
    if (call.state === "cancelled-before-delivery" || call.state === "queued") continue;
    // A checkpoint covers settled results only, never an outstanding external action.
    if (covered.has(call.callId) && call.state === "settled") continue;
    const item = supplied.get(call.callId) ?? local?.get(call.callId);
    if (!item) throw continuityError(call.state === "settled" ? "continuity_context_missing" : "continuity_execution_unsettled", "An issued call requires its real result body.");
    accepts.push(item);
    if (!supplied.has(call.callId)) missing.push(item);
  }
  acceptRecoveryResults(ref, accepts);
  record = recoveryRecord(ref);
  if (Object.values(record.calls).some(call => call.workLineageId === work.workLineageId && call.state === "delivery-possible")) throw continuityError("continuity_execution_unsettled");
  const result = structuredClone(parsed);
  if (missing.length) {
    const raw = result._rawBody as { input: unknown[] };
    raw.input.push(...missing);
    const parsedMissing = parseRequest({ model: result.modelId, input: missing });
    result.context.messages.push(...parsedMissing.context.messages);
  }
  const control = "Recovery status: The previous response was interrupted. The tool results in this context are real completed returns. Do not replay their old tool calls. Continue only the unfinished accepted instruction. A returned command session ID identifies the existing command; it does not mean the process exited.";
  result.context.systemPrompt = [...result.context.systemPrompt ?? [], control];
  return result;
}
export function recoveryFinalReceipt(directory: string, record: RecoveryThreadRecord, logicalWorkId: string): RuntimeRecoveryFinalReceipt {
  const work = record.works[logicalWorkId];
  if (work?.purpose !== "ordinary" || work.state !== "completed" || !work.terminalReceiptId || !work.terminalDigest) {
    throw continuityError("continuity_source_unproven", "The ordinary work has no committed final receipt.");
  }
  return Object.freeze({ directory, thread: record.thread, logicalWorkId: work.logicalWorkId,
    workLineageId: work.workLineageId, terminalReceiptId: work.terminalReceiptId, terminalDigest: work.terminalDigest });
}
export function completeRecoveryWork(ref: RuntimeRecoveryReference, answer: string): RuntimeRecoveryFinalReceipt {
  const record = assertRecoveryWriter(ref);
  const completed = recoveryStore(ref).completeWork(ref.thread, { scope: record.scope, expectedVersion: record.version }, ref.logicalWorkId,
    { receiptId: recoveryDigest([ref.logicalWorkId, "final"]), digest: recoveryDigest(answer) });
  return recoveryFinalReceipt(ref.directory, completed, ref.logicalWorkId);
}
export function stopRecoveryWork(ref: RuntimeRecoveryReference, reason: RecoveryWorkRecord["stopReason"] = "user-stop"): void {
  const record = recoveryRecord(ref);
  recoveryStore(ref).stopWork(ref.thread, { scope: record.scope }, ref.logicalWorkId, reason);
}
export function recoveryIdentity(record: RecoveryThreadRecord, installationId: string): ContinuityRecoveryIdentity {
  const transaction = record.transaction;
  if (!transaction) throw continuityError("continuity_source_unproven");
  return { schemaVersion: 2, installationId, threadKey: record.thread, epoch: transaction.targetEpoch,
    transactionId: transaction.transactionId, transactionVersion: transaction.version,
    logicalWorkId: transaction.logicalWorkId, attempt: transaction.attempt,
    snapshotVersion: transaction.snapshotVersion, snapshotDigest: transaction.snapshotDigest,
    ownerProcess: { pid: record.owner.pid, startIdentity: record.owner.startIdentity },
    ...(transaction.launcherInstance ? { launcherInstance: transaction.launcherInstance } : {}) };
}

/** Revoke the target writer; process liveness alone does not keep a retired thread locked. */
export async function retireRecoveryWriter(
  bindings: import("./continuity-binding").ContinuityBindings,
  observed: RecoveryThreadRecord,
  descriptor: string,
): Promise<RecoveryThreadRecord> {
  const { chatGptTurnSessions } = await import("./turn-execution");
  const { continuityProcessInstanceStatus } = await import("./continuity-recovery-store");
  const { retireLauncherContinuityWriter } = await import("../../launcher-browser-host");
  const binding = bindings.observed(observed.thread);
  const source = binding ? (binding.executionKey ? chatGptTurnSessions.find(binding.executionKey) : undefined)
    ?? chatGptTurnSessions.findFailedContinuityCreation(binding) : undefined;
  let locallyRetired = false;
  if (source) {
    await source.runtime.retireCapability?.();
    if (source.isActive()) source.cancel(Object.assign(new Error("The previous continuity writer is retired for recovery."), { code: "continuity_recovery_retired" }));
    await source.physicalSettlement;
    locallyRetired = true;
  }
  const work = observed.currentWorkId ? observed.works[observed.currentWorkId] : undefined;
  const attempt = work?.attempts.at(-1);
  const retiredPreparation = observed.retiredPreparation?.expected.transaction;
  const stoppedPreparationRetired = retiredPreparation?.logicalWorkId === work?.logicalWorkId
    && retiredPreparation?.attempt === attempt?.attempt && retiredPreparation?.targetEpoch === attempt?.epoch;
  if (attempt && (!attempt.writerRetired || (work?.state === "stopped" && !stoppedPreparationRetired))) {
    // Local Broker revocation and page settlement prove both writers. After a backend
    // restart, Launcher retirement proves the page; the old process identity proves Broker.
    let pageRetired = locallyRetired;
    if (observed.transaction) {
      try {
        const receipt = await retireLauncherContinuityWriter(descriptor,
          recoveryIdentity(observed, bindings.recoveryStore.installationId()));
        pageRetired ||= receipt.writerRetired === true;
      } catch (error) {
        if (!locallyRetired) throw continuityError("continuity_unverified", "The previous page writer retirement could not be verified.");
      }
    }
    if (!locallyRetired && bindings.broker?.retireRecoveryWriter) {
      locallyRetired = await bindings.broker.retireRecoveryWriter({ directory: bindings.registrations.directory,
        thread: observed.thread, logicalWorkId: work!.logicalWorkId, attempt: attempt.attempt }).catch(() => false);
    }
    if (work?.purpose === "compaction" && attempt.dispatchProtocolComplete && pageRetired
      && !Object.values(observed.calls).some(call => call.logicalWorkId === work.logicalWorkId && call.attempt === attempt.attempt)) locallyRetired = true;
    // A durable stop fences every Broker dispatch, but cannot prove that the old
    // browser writer has retired. Require its independent page receipt above.
    if (work?.state === "stopped" && attempt.dispatchProtocolComplete) locallyRetired = true;
    const processExited = continuityProcessInstanceStatus(observed.owner) === "exited";
    if (!locallyRetired && !processExited) throw continuityError("continuity_execution_unsettled", "The previous Broker writer has not acknowledged retirement.");
    if (!pageRetired) throw continuityError("continuity_unverified");
    const current = bindings.recoveryStore.get(observed.thread)!;
    bindings.recoveryStore.retireAttempt(current.thread, { scope: current.scope, expectedVersion: current.version }, work!.logicalWorkId, attempt.attempt);
  }
  if (source?.settledOutcome()?.type === "error" && binding?.executionKey) {
    chatGptTurnSessions.retire(binding.executionKey, source,
      Object.assign(new Error("The continuity writer was retired for recovery."), { code: "continuity_recovery_retired" }));
  }
  return bindings.recoveryStore.get(observed.thread)!;
}

export interface RecoveryAppendAdmission {
  logicalWorkId: string; instructionIdentity: string; nativeTurnId: string;
  workPayloadDigest: string; snapshotDigest: string;
  localSessionId: string; localTaskRevision: number;
  results: Array<{ callId: string; resultType: string; resultDigest: string }>;
}
/** Broker calls this after validation, immediately before publishing the new writer version. */
export function recordRecoveryAppend(ref: RuntimeRecoveryReference, input: RecoveryAppendAdmission): void | { committed: boolean; confirm: () => void } {
  const record = assertRecoveryWriter(ref);
  const store = recoveryStore(ref);
  let candidate: RecoveryThreadRecord | undefined;
  let updated: RecoveryThreadRecord;
  let confirmation: { committed: boolean; confirm: () => void } | undefined;
  try { updated = store.transact(ref.thread, { scope: record.scope, expectedVersion: record.version }, draft => {
    candidate = draft;
    const predecessor = draft.works[ref.logicalWorkId]!;
    const lineage = draft.lineages[predecessor.workLineageId]!;
    for (const result of input.results) {
      const call = draft.calls[result.callId];
      if (!call || call.workLineageId !== predecessor.workLineageId || call.expectedResultType !== result.resultType
        || !["delivery-possible", "settled"].includes(call.state)) throw continuityError("continuity_context_missing");
      if (call.firstResultDigest && call.firstResultDigest !== result.resultDigest) throw continuityError("continuity_result_conflict");
      call.state = "settled"; call.firstResultDigest = result.resultDigest;
    }
    if (input.logicalWorkId === ref.logicalWorkId) return;
    if (draft.works[input.logicalWorkId] || lineage.headLogicalWorkId !== predecessor.logicalWorkId) throw continuityError("continuity_source_unproven");
    const oldAttempt = predecessor.attempts[ref.attempt]!;
    oldAttempt.writerRetired = true;
    const taskRevision = ++lineage.acceptedTaskRevision;
    lineage.headLogicalWorkId = input.logicalWorkId;
    lineage.taskMappings[recoveryDigest([input.localSessionId, input.localTaskRevision])] = taskRevision;
    const next = { attempt: 0, epoch: draft.epoch, historyRevision: draft.historyRevision,
      snapshotVersion: oldAttempt.snapshotVersion, snapshotDigest: input.snapshotDigest,
      stage: "accepted" as const, dispatchProtocolComplete: true, writerRetired: false,
      ...(oldAttempt.launcherInstance ? { launcherInstance: structuredClone(oldAttempt.launcherInstance) } : {}) };
    draft.works[input.logicalWorkId] = { logicalWorkId: input.logicalWorkId, instructionIdentity: input.instructionIdentity,
      nativeTurnId: input.nativeTurnId, workPayloadDigest: input.workPayloadDigest, purpose: "ordinary", state: "active",
      workLineageId: predecessor.workLineageId, acceptedTaskRevision: taskRevision,
      predecessorLogicalWorkId: predecessor.logicalWorkId, attempts: [next], retryBudget: { attempts: 1, startedAt: Date.now() } };
    draft.currentWorkId = input.logicalWorkId;
    if (draft.transaction?.logicalWorkId === predecessor.logicalWorkId) draft.transaction.writerRetired = true;
  }); } catch (error) {
    // Atomic replacement can succeed before its directory fsync or reply fails. Only
    // an exact readback of this entire CAS candidate establishes accepted B; every
    // pre-commit failure still leaves A unchanged and propagates its original error.
    let observed: RecoveryThreadRecord | undefined;
    const accepted = candidate && { ...candidate, version: record.version + 1 };
    const exactAccepted = (value: RecoveryThreadRecord | undefined): value is RecoveryThreadRecord => Boolean(accepted && value
      && value.version === record.version + 1 && recoveryDigest(value) === recoveryDigest(accepted));
    try {
      observed = store.get(ref.thread);
    } catch { /* A failed readback cannot establish a pre-commit rejection. */ }
    if (!exactAccepted(observed) && !(accepted && (error as { writeMayHaveCommitted?: boolean }).writeMayHaveCommitted)) throw error;
    updated = exactAccepted(observed) ? observed : accepted!;
    // The Broker keeps a committed, fenced transfer while this confirmation is
    // unavailable. Retry the same transfer before helper publication or completion.
    confirmation = { committed: exactAccepted(observed), confirm: () => {
      const readback = store.get(ref.thread);
      if (!exactAccepted(readback)) throw continuityError("continuity_unverified", "The accepted append cannot be confirmed from its exact durable candidate.");
      store.confirmDurable(ref.thread, { scope: record.scope, expectedVersion: readback.version,
        expectedEpoch: record.epoch, expectedOwner: record.owner.id });
      ref.logicalWorkId = readback.currentWorkId!;
      ref.attempt = readback.works[ref.logicalWorkId]!.attempts.at(-1)!.attempt;
    } };
  }
  if (!confirmation || confirmation.committed) {
    ref.logicalWorkId = updated.currentWorkId!;
    ref.attempt = updated.works[ref.logicalWorkId]!.attempts.at(-1)!.attempt;
  }
  return confirmation;
}
