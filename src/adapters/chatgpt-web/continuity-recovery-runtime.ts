import { getLauncherKnownUnsentReceipt } from "../../launcher-browser-host";
import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { parseRequest } from "../../responses/parser";
import { canonicalJson } from "./canonical-json";
import { continuityError, withRetiredWriterReason } from "./continuity-errors";
import { ContinuityRecoveryStore, continuityProcessInstance, type RecoveryThreadRecord, type RecoveryWorkRecord } from "./continuity-recovery-store";
import type { ContinuityRecoveryIdentity } from "./continuity-contract";
import type { BrokerToolRequest } from "./turn-broker";
import { assertContextCoverageAdvance, validateContextCoverageMetadata, type ContextCoverageMetadata } from "./context-coverage-journal";
import { CompactionSourceCoverage } from "./compaction-context";
import type { ContextSnapshot } from "./context-snapshot";
import type { TaskInputIdentity } from "./continuity-task-input-types";
import { retainContinuityOrdinaryReplayTombstone } from "./continuity-binding";

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
export function forgetRecoveryPage(directory: string, thread: string): void {
  const key = `${directory}:${thread}`;
  resultBodies.delete(key); resultBodyReferences.delete(key);
}
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
    throw withRetiredWriterReason(continuityError("continuity_source_unproven", "An obsolete execution cannot write to the current recovery attempt."));
  }
  return record;
}
/** The callback commits synchronously; it must not start another journal transaction. */
export function withRecoveryWriter<T>(ref: RuntimeRecoveryReference, commit: () => T): T {
  return recoveryStore(ref).withWriterAuthority(ref, commit);
}
/** False means the original helper no longer owns failure or stop authority; no journal write occurred. */
export function settleRecoveryFailure(ref: RuntimeRecoveryReference, stopReason?: NonNullable<RecoveryWorkRecord["stopReason"]>): boolean {
  return recoveryStore(ref).settleWriterFailure(ref, stopReason) !== undefined;
}
/** Captured by the trusted outer transport before its one possible Send, never model input. */
export interface RuntimeRecoverySendReference {
  readonly directory: string;
  readonly scope: string;
  readonly identity: ContinuityRecoveryIdentity;
  readonly authorizationId: string;
}
export function beginRecoverySend(ref: RuntimeRecoveryReference, original: ContinuityRecoveryIdentity,
  authorizationId?: string, authorize?: () => void): RuntimeRecoverySendReference {
  const record = recoveryRecord(ref);
  if (ref.ownerId !== undefined && ref.ownerId !== record.owner.id) throw continuityError("continuity_source_unproven");
  if (original.threadKey !== ref.thread || original.logicalWorkId !== ref.logicalWorkId || original.attempt !== ref.attempt) {
    throw continuityError("continuity_source_unproven", "The Send authorization belongs to another original attempt.");
  }
  const store = recoveryStore(ref);
  const next = store.markAttempt(ref.thread, { scope: record.scope, expectedVersion: record.version }, {
    logicalWorkId: ref.logicalWorkId, attempt: ref.attempt, stage: "send-possible",
    transactionVersion: original.transactionVersion, sendIdentity: original, authorize, ...(authorizationId ? { sendAuthorizationId: authorizationId } : {}) });
  return Object.freeze({ directory: ref.directory, scope: record.scope, identity: Object.freeze(structuredClone(original)),
    authorizationId: next.works[ref.logicalWorkId]!.attempts[ref.attempt]!.sendEvidence!.authorizationId });
}
export function beginRecoveryAcquisition(ref: RuntimeRecoveryReference, original: ContinuityRecoveryIdentity, requestId: string): void {
  if (original.threadKey !== ref.thread || original.logicalWorkId !== ref.logicalWorkId || original.attempt !== ref.attempt) throw continuityError("continuity_source_unproven");
  const record = assertRecoveryWriter(ref);
  // Reattaching an already acquired physical page cannot produce a no-allocation receipt.
  if (record.works[ref.logicalWorkId]!.attempts[ref.attempt]!.stage === "page-acquired") return;
  recoveryStore(ref).beginAcquisition(ref.thread, { scope: record.scope, expectedVersion: record.version }, original, requestId);
}
/** Only authenticated, exact transport errors can roll an unexecuted transaction back to prepared. */
export function settleRecoveryKnownUnsent(ref: RuntimeRecoveryReference, error: unknown): boolean {
  const receipt = getLauncherKnownUnsentReceipt(error);
  if (!receipt) return false;
  const record = assertRecoveryWriter(ref);
  if (receipt.recovery.threadKey !== ref.thread || receipt.recovery.logicalWorkId !== ref.logicalWorkId || receipt.recovery.attempt !== ref.attempt) throw continuityError("continuity_source_unproven");
  recoveryStore(ref).settleKnownUnsent(ref.thread, { scope: record.scope, expectedVersion: record.version }, receipt.recovery, receipt.requestId, receipt.receiptId);
  return true;
}
/** Settlement records only the original Send; false forbids publishing new delivery/coverage facts. */
export function settleRecoverySend(reference: RuntimeRecoverySendReference): { record: RecoveryThreadRecord; currentWriter: boolean } {
  const store = new ContinuityRecoveryStore(reference.directory);
  const record = store.settleSendReceipt(reference.identity.threadKey, { scope: reference.scope }, reference.identity, reference.authorizationId);
  return { record, currentWriter: store.hasSendWriterAuthority(reference.identity) };
}
/** Merge complete in-memory evidence; missing entries are not proof of restored sources. */
function applyRecoveryContextCoverage(record: RecoveryThreadRecord, ref: RuntimeRecoveryReference,
  metadata: readonly Readonly<ContextCoverageMetadata>[], consumeReservation = true): void {
  const work = record.works[ref.logicalWorkId]!;
  const attempt = work.attempts[ref.attempt]!;
  const incoming = new Map<string, Readonly<ContextCoverageMetadata>>();
  for (const value of metadata) {
    validateContextCoverageMetadata(value);
    if (incoming.has(value.planId)) throw continuityError("continuity_source_unproven", "Source coverage contains duplicate plans.");
    incoming.set(value.planId, value);
  }
  const retainedAll = record.contextCoverage ?? [];
  const retained = retainedAll.filter(entry => entry.workLineageId === work.workLineageId);
  for (const entry of retainedAll) {
    if (entry.workLineageId === work.workLineageId || !incoming.has(entry.metadata.planId)) continue;
    if (canonicalJson(entry.metadata) !== canonicalJson(incoming.get(entry.metadata.planId)!)) {
      throw continuityError("continuity_source_unproven", "A source plan cannot change another instruction lineage's coverage.");
    }
  }
  for (const entry of retained) {
    if (!incoming.has(entry.metadata.planId)) throw continuityError("continuity_source_unproven",
      "The retained digest journal has uncovered sources that were not independently restored; compaction source recovery is unavailable.");
    const after = incoming.get(entry.metadata.planId)!;
    assertContextCoverageAdvance(entry.metadata, after);
    if (canonicalJson(entry.metadata) !== canonicalJson(after) && entry.ownerId !== record.owner.id) {
      throw continuityError("continuity_source_unproven", "A source candidate cannot modify another owner's coverage.");
    }
  }
  const entries = retained.map(entry => ({ ...entry,
    sourceTaskRevision: canonicalJson(entry.metadata) === canonicalJson(incoming.get(entry.metadata.planId)!) ? entry.sourceTaskRevision
      : Math.max(entry.sourceTaskRevision, work.acceptedTaskRevision),
    metadata: structuredClone(incoming.get(entry.metadata.planId)!) }));
  for (const value of metadata) {
    if (retainedAll.some(entry => entry.metadata.planId === value.planId)) continue;
    if (retainedAll.some(entry => !entry.metadata.delivered && (entry.workLineageId === work.workLineageId || incoming.has(entry.metadata.planId)))) {
      throw continuityError("continuity_source_unproven", "An unresolved selected source Send prevents a replacement plan.");
    }
    // A post-checkpoint memory cleanup can still hold the just-covered entries.
    if (Object.values(record.checkpoints).some(commit => commit.workLineageId === work.workLineageId
      && commit.sourceHistoryRevision >= value.historyRevision && commit.acceptedTaskRevision >= work.acceptedTaskRevision)) continue;
    if (value.historyRevision !== record.historyRevision || value.historyRevision !== attempt.historyRevision) {
      throw continuityError("continuity_source_unproven", "Source coverage is bound to another history revision.");
    }
    entries.push({ ownerId: record.owner.id, logicalWorkId: work.logicalWorkId, workLineageId: work.workLineageId,
      attempt: attempt.attempt, epoch: attempt.epoch, acceptedTaskRevision: work.acceptedTaskRevision,
      sourceTaskRevision: work.acceptedTaskRevision, metadata: structuredClone(value) });
  }
  const byPlan = new Map(entries.map(entry => [entry.metadata.planId, entry]));
  record.contextCoverage = [...retainedAll.map(entry => byPlan.get(entry.metadata.planId) ?? entry),
    ...entries.filter(entry => !retainedAll.some(previous => previous.metadata.planId === entry.metadata.planId))];
  const reservation = record.contextCoverageReservations?.find(value => value.logicalWorkId === ref.logicalWorkId && value.attempt === ref.attempt);
  if (consumeReservation && reservation && canonicalJson(entries) !== canonicalJson(retained)) {
    if (reservation.ownerId !== record.owner.id || !reservation.candidateDigests.includes(recoveryDigest(entries.map(entry => entry.metadata)))) {
      throw continuityError("continuity_source_unproven", "The selected source plan does not match its reserved candidate.");
    }
    record.contextCoverageReservations = record.contextCoverageReservations!.filter(value => value !== reservation);
  }
}
/** Reserve before a manual candidate can be copied or displayed. No candidate is delivered evidence. */
export function reserveRecoveryContextCoverage(ref: RuntimeRecoveryReference,
  candidates: readonly (readonly Readonly<ContextCoverageMetadata>[])[]): void {
  if (!candidates.length || candidates.length > 2) throw continuityError("continuity_source_unproven", "Source admission requires one or two fixed candidates.");
  const record = assertRecoveryWriter(ref);
  const lineage = record.works[ref.logicalWorkId]!.workLineageId;
  const candidateRecords = candidates.map(metadata => {
    const candidate = structuredClone(record); applyRecoveryContextCoverage(candidate, ref, metadata, false);
    return (candidate.contextCoverage ?? []).filter(entry => entry.workLineageId === lineage);
  });
  const candidateDigests = [...new Set(candidateRecords.map(entries => recoveryDigest(entries.map(entry => entry.metadata))))];
  const existing = record.contextCoverageReservations?.find(value => value.logicalWorkId === ref.logicalWorkId && value.attempt === ref.attempt);
  if (existing) {
    if (existing.ownerId !== record.owner.id || canonicalJson(existing.candidateDigests) !== canonicalJson(candidateDigests)) {
      throw continuityError("continuity_source_unproven", "The existing source candidate reservation cannot be rebound.");
    }
    recoveryStore(ref).confirmDurable(ref.thread, { scope: record.scope, expectedVersion: record.version, expectedOwner: record.owner.id });
    return;
  }
  let bytes = 0;
  for (const entries of candidateRecords) {
    // Charge the complete candidate including owner bindings, not only the bare hashes.
    bytes = Math.max(bytes, Buffer.byteLength(JSON.stringify(entries)) + 256);
  }
  recoveryStore(ref).transact(ref.thread, { scope: record.scope, expectedVersion: record.version, expectedOwner: record.owner.id }, draft => {
    (draft.contextCoverageReservations ??= []).push({ ownerId: record.owner.id, logicalWorkId: ref.logicalWorkId,
      attempt: ref.attempt, epoch: draft.epoch, historyRevision: draft.historyRevision, candidateDigests, bytes });
  });
}
export interface RecoveryContextCoverage {
  metadata(): readonly Readonly<ContextCoverageMetadata>[];
  bindPersistence(persist: (metadata: readonly Readonly<ContextCoverageMetadata>[]) => void,
    initialMetadata?: readonly Readonly<ContextCoverageMetadata>[]): void;
}
/** Verify real recovered bytes before recovering only the current lineage's digest ledger. */
export function restoreRecoveryContextCoverage(ref: RuntimeRecoveryReference, snapshot: ContextSnapshot): CompactionSourceCoverage | undefined {
  const record = assertRecoveryWriter(ref);
  const work = record.works[ref.logicalWorkId]!;
  const entries = (record.contextCoverage ?? []).filter(entry => entry.workLineageId === work.workLineageId);
  if (!entries.length) return undefined;
  const currentAttempt = work.attempts[ref.attempt]!;
  for (const related of Object.values(record.works)) {
    if (related.workLineageId !== work.workLineageId) continue;
    if (related.attempts.some(attempt => !attempt.dispatchProtocolComplete || attempt !== currentAttempt && !attempt.writerRetired)) {
      throw continuityError("continuity_source_unproven", "Source coverage recovery requires every prior writer to be proved retired.");
    }
  }
  if (Object.values(record.calls).some(call => call.workLineageId === work.workLineageId
    && !["settled", "cancelled-before-delivery"].includes(call.state))) {
    throw continuityError("continuity_execution_unsettled", "Source coverage recovery requires all issued calls to have real settlement evidence.");
  }
  const checkpointed = new Set(Object.values(record.checkpoints).filter(checkpoint => checkpoint.workLineageId === work.workLineageId)
    .flatMap(checkpoint => checkpoint.coveredCallIds));
  for (const call of Object.values(record.calls)) {
    if (call.workLineageId !== work.workLineageId || call.state !== "settled" || checkpointed.has(call.callId)) continue;
    if (!snapshot.targets.some(target => target.call_id === call.callId && target.original_role === "toolResult")) {
      throw continuityError("continuity_context_missing", "The recovered source snapshot omits an uncovered real tool result.");
    }
  }
  if (entries.some(entry => entry.metadata.historyRevision !== record.historyRevision
    || entry.sourceTaskRevision > work.acceptedTaskRevision)) {
    throw continuityError("continuity_source_unproven", "The recovered source journal belongs to another history or accepted instruction revision.");
  }
  return CompactionSourceCoverage.restoreVerifiedSource(snapshot, entries.map(entry => entry.metadata), record.historyRevision);
}
/** Only an explicit pre-publication capacity rejection permits this cleanup. */
export function releaseRecoveryContextCoverageReservation(ref: RuntimeRecoveryReference): void {
  const record = assertRecoveryWriter(ref);
  recoveryStore(ref).releaseContextCoverageReservation(ref.thread,
    { scope: record.scope, expectedVersion: record.version, expectedOwner: record.owner.id },
    { logicalWorkId: ref.logicalWorkId, attempt: ref.attempt, ownerId: ref.ownerId ?? record.owner.id });
}
/** The callback must complete before the coverage object publishes a mutation. */
export function bindRecoveryContextCoverage(ref: RuntimeRecoveryReference, coverage: RecoveryContextCoverage,
  initialMetadata?: readonly Readonly<ContextCoverageMetadata>[]): void {
  const ownerId = ref.ownerId ?? recoveryRecord(ref).owner.id;
  if (initialMetadata) {
    const record = assertRecoveryWriter({ ...ref, ownerId });
    const lineage = record.works[ref.logicalWorkId]!.workLineageId;
    const foreignPlans = new Set((record.contextCoverage ?? []).filter(entry => entry.workLineageId !== lineage).map(entry => entry.metadata.planId));
    if (canonicalJson(initialMetadata.filter(value => !foreignPlans.has(value.planId)))
      !== canonicalJson((record.contextCoverage ?? []).filter(entry => entry.workLineageId === lineage).map(entry => entry.metadata))) {
      throw continuityError("continuity_source_unproven", "Rebinding source coverage requires the exact already committed append metadata.");
    }
  }
  const persist = (metadata: readonly Readonly<ContextCoverageMetadata>[]): void => {
    const record = recoveryRecord(ref);
    if (record.owner.id !== ownerId) throw continuityError("continuity_source_unproven", "An obsolete owner cannot write source coverage.");
    const candidate = structuredClone(record);
    applyRecoveryContextCoverage(candidate, ref, metadata);
    if (canonicalJson(candidate.contextCoverage ?? []) === canonicalJson(record.contextCoverage ?? [])
      && canonicalJson(candidate.contextCoverageReservations ?? []) === canonicalJson(record.contextCoverageReservations ?? [])) {
      if (record.contextCoverage?.length || record.contextCoverageReservations?.length) {
        recoveryStore(ref).confirmDurable(ref.thread, { scope: record.scope, expectedVersion: record.version, expectedOwner: ownerId });
      }
      return;
    }
    assertRecoveryWriter({ ...ref, ownerId });
    recoveryStore(ref).transact(ref.thread, { scope: record.scope, expectedVersion: record.version, expectedOwner: ownerId }, draft => {
      applyRecoveryContextCoverage(draft, ref, metadata);
    });
  };
  coverage.bindPersistence(persist, initialMetadata);
}
/** Every Broker entry uses this one boundary before returning calls to an outer executor. */
export function recordRecoveryDelivery(ref: RuntimeRecoveryReference, requests: Array<BrokerToolRequest & { operationId?: number }>, authorize?: () => void): void {
  // An observer may drain an empty queue after the accepted final retired its writer.
  // There is no dispatch authority or durable evidence to publish in that case.
  if (!requests.length) return;
  const record = assertRecoveryWriter(ref);
  const store = recoveryStore(ref);
  // Publish identities and delivery-possible in one atomic write. An interrupted return is
  // deliberately unknown, never proof that the outer executor did not receive the call.
  store.transact(ref.thread, { scope: record.scope, expectedVersion: record.version }, draft => {
    authorize?.();
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
  const pendingById = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const id = String(item.call_id);
    if (!bodies.has(id) && !pendingById.has(id)) pendingById.set(id, item);
  }
  const pending = [...pendingById.values()];
  if (!pending.length) return;
  try {
    if (recoveryStore(ref).setResultBodiesBytes(ref.thread, { scope: record.scope },
      pending.map(item => ({ callId: String(item.call_id), bytes: Buffer.byteLength(JSON.stringify(item)) })), resultBodyOwner)) {
      for (const item of pending) bodies.set(String(item.call_id), structuredClone(item));
      return;
    }
  } catch { /* Keep accepted terminal facts, and attempt independent optional reservations below. */ }
  // Capacity or ownership can reject one item without preventing other bodies from fitting.
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
  const store = recoveryStore(ref);
  const record = store.get(ref.thread);
  const work = record?.works[ref.logicalWorkId];
  if (!record || !work || record.currentWorkId !== ref.logicalWorkId || work.attempts.at(-1)?.attempt !== ref.attempt
    || ref.ownerId !== undefined && ref.ownerId !== record.owner.id) return;
  store.stopWork(ref.thread, { scope: record.scope, expectedVersion: record.version, expectedOwner: record.owner.id }, ref.logicalWorkId, reason);
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
  sourceTask?: TaskInputIdentity,
  compaction?: { executionKey: string; replaySource?: { executionKey: string; historyRevision: number } },
): Promise<RecoveryThreadRecord> {
  const { chatGptTurnSessions } = await import("./turn-execution");
  const { continuityProcessInstanceStatus } = await import("./continuity-recovery-store");
  const { retireLauncherContinuityWriter } = await import("../../launcher-browser-host");
  const binding = bindings.observed(observed.thread);
  const source = binding ? (binding.executionKey ? chatGptTurnSessions.find(binding.executionKey) : undefined)
    ?? chatGptTurnSessions.findFailedContinuityCreation(binding) : undefined;
  const compactionReplaySource = compaction?.replaySource;
  if (compactionReplaySource && (!binding || !source || binding.executionKey !== compactionReplaySource.executionKey
    || source.runtime.continuityBinding !== binding
    || source.runtime.usageInput?._continuityHistoryRevision !== compactionReplaySource.historyRevision)) {
    throw continuityError("continuity_source_unproven");
  }
  const preserveSourceReplay = Boolean(compactionReplaySource && source?.hasCompletedContinuityReplay());
  const work = observed.currentWorkId ? observed.works[observed.currentWorkId] : undefined;
  const attempt = work?.attempts.at(-1);
  if (attempt) {
    // A live instance must prove this protocol, not merely be running new files on disk.
    if (bindings.broker?.assertRecoveryFencing) await bindings.broker.assertRecoveryFencing();
    else if (continuityProcessInstanceStatus(observed.owner) !== "exited") throw continuityError("continuity_configuration_conflict", "The running Broker cannot prove execution generation fencing; update and restart it.");
    // This CAS and dispatch registration use the same storage lock. After this commit,
    // every old process observes the fence even if cancellation or cleanup loses its reply.
    const current = bindings.recoveryStore.get(observed.thread)!;
    if (current.version !== observed.version || current.owner.id !== observed.owner.id
      || current.currentWorkId !== work!.logicalWorkId || current.epoch !== observed.epoch) {
      throw continuityError("continuity_source_unproven", "The retirement observation is stale; inspect the current writer again.");
    }
    if (!attempt.writerRetired || sourceTask) bindings.recoveryStore.retireAttempt(current.thread,
      { scope: current.scope, expectedVersion: current.version, expectedOwner: current.owner.id }, work!.logicalWorkId, attempt.attempt, sourceTask);
    if (compaction && binding && bindings.observed(current.thread) === binding && binding.epoch === current.epoch) {
      // Retirement can schedule the source's release callback before a successor
      // attempt exists. Keep the journal through that callback and capacity waits.
      binding.recoveryCleanupExecutionKey = compaction.executionKey;
    }
    if (preserveSourceReplay) retainContinuityOrdinaryReplayTombstone(binding!, compactionReplaySource!.executionKey,
      compactionReplaySource!.historyRevision, source!.acceptedContinuityInstructionIdentity(), source!.nativeTurnId);
    if (source) {
      try { await source.runtime.retireCapability?.(); }
      catch { /* The durable fence already denies effects; late coverage cannot delay isolation. */ }
      if (source.isActive()) source.cancel(Object.assign(new Error("The previous task writer is retired for recovery."), { code: "continuity_recovery_retired" }));
    }
    if (bindings.broker?.retireRecoveryWriter) await bindings.broker.retireRecoveryWriter({ directory: bindings.registrations.directory,
      thread: observed.thread, logicalWorkId: work!.logicalWorkId, attempt: attempt.attempt });
    if (observed.transaction) {
      const original = recoveryIdentity(observed, bindings.recoveryStore.installationId());
      const retiredPreparation = observed.retiredPreparation;
      const archivedExpected = retiredPreparation && recoveryIdentity({ ...observed, ...retiredPreparation.expected }, bindings.recoveryStore.installationId());
      // A stopped CAS may have applied its target before the reply was lost. Its
      // archived pair remains the exact cleanup authority after pending is cleared.
      let receipt;
      if (work!.state === "stopped" && archivedExpected && canonicalJson(archivedExpected) === canonicalJson(original)) {
        const target = recoveryIdentity({ ...observed, ...retiredPreparation!.target }, bindings.recoveryStore.installationId());
        try { receipt = await retireLauncherContinuityWriter(descriptor, target, bindings.registrations.directory); }
        catch { receipt = await retireLauncherContinuityWriter(descriptor, original, bindings.registrations.directory); }
      } else receipt = await retireLauncherContinuityWriter(descriptor, original, bindings.registrations.directory);
      if (receipt.writerRetired !== true) throw continuityError("continuity_unverified", "The page execution fence could not be verified.");
      if (receipt.physicalCleanup !== "destroyed") {
        const isolated = bindings.recoveryStore.get(observed.thread)!;
        if (isolated.takeoverNoticeEpoch !== attempt.epoch) bindings.recoveryStore.transact(observed.thread,
          { scope: isolated.scope, expectedVersion: isolated.version }, record => { record.takeoverNoticePending = true; record.takeoverNoticeEpoch = attempt.epoch; });
      }
      if (!attempt.writerRetired) {
        const settled = bindings.recoveryStore.get(observed.thread)!;
        const calls = Object.values(settled.calls).filter(call => call.workLineageId === work!.workLineageId);
        console.info(`[chatgpt-web] execution_isolated ${JSON.stringify({ thread: observed.thread.slice(0, 16),
          epoch: attempt.epoch, attempt: attempt.attempt, dispatched: calls.filter(call => call.state !== "queued" && call.state !== "cancelled-before-delivery").length,
          settled: calls.filter(call => call.state === "settled").length, physicalCleanup: receipt.physicalCleanup ?? "pending",
          guarantee: "project-controlled-effects-only", platformActivity: "unverified" })}`);
      }
    }
    // Physical settlement is independent. Live or failed-to-close pages retain their slot.
  }
  if (source?.settledOutcome()?.type === "error" && binding?.executionKey) {
    const reason = Object.assign(new Error("The continuity writer was retired for recovery."), { code: "continuity_recovery_retired" });
    if (preserveSourceReplay) chatGptTurnSessions.retirePreservingContinuityReplay(binding.executionKey, source, reason);
    else chatGptTurnSessions.retire(binding.executionKey, source, reason);
  }
  return bindings.recoveryStore.get(observed.thread)!;
}

export interface RecoveryAppendAdmission {
  logicalWorkId: string; instructionIdentity: string; nativeTurnId: string;
  workPayloadDigest: string; snapshotDigest: string;
  localSessionId: string; localTaskRevision: number;
  results: Array<{ callId: string; resultType: string; resultDigest: string }>;
  contextCoverage?: readonly Readonly<ContextCoverageMetadata>[];
}
/** Broker calls this after validation, immediately before publishing the new writer version. */
export function recordRecoveryAppend(ref: RuntimeRecoveryReference, input: RecoveryAppendAdmission, updates?: readonly import("./task-update-protocol").UserUpdate[], driverGeneration?: number, authorize?: () => void): void | { committed: boolean; confirm: () => void } {
  const record = assertRecoveryWriter(ref);
  const store = recoveryStore(ref);
  let candidate: RecoveryThreadRecord | undefined;
  let updated: RecoveryThreadRecord;
  let confirmation: { committed: boolean; confirm: () => void } | undefined;
  try { updated = store.transact(ref.thread, { scope: record.scope, expectedVersion: record.version }, draft => {
    authorize?.();
    candidate = draft;
    if (input.contextCoverage) applyRecoveryContextCoverage(draft, ref, input.contextCoverage);
    const predecessor = draft.works[ref.logicalWorkId]!;
    const lineage = draft.lineages[predecessor.workLineageId]!;
    for (const result of input.results) {
      const call = draft.calls[result.callId];
      if (!call || call.workLineageId !== predecessor.workLineageId || call.expectedResultType !== result.resultType
        || !["delivery-possible", "settled"].includes(call.state)) throw continuityError("continuity_context_missing");
      if (call.firstResultDigest && call.firstResultDigest !== result.resultDigest) throw continuityError("continuity_result_conflict");
      call.state = "settled"; call.firstResultDigest = result.resultDigest;
    }
    const taskUpdateJournal = predecessor.taskUpdateJournal && structuredClone(predecessor.taskUpdateJournal);
    if (updates) {
      if (!taskUpdateJournal || driverGeneration !== taskUpdateJournal.driverGeneration + 1
        || updates.some((update, index) => update.revision !== taskUpdateJournal.acceptedRevision + index + 1 || recoveryDigest(update.content) !== update.payloadDigest)
        || new Set([...taskUpdateJournal.updates, ...updates].map(update => update.sourceMessageId)).size !== taskUpdateJournal.updates.length + updates.length
        || input.localTaskRevision !== taskUpdateJournal.acceptedRevision + updates.length) throw continuityError("continuity_source_unproven", "The append is not the next durable task update range.");
      taskUpdateJournal.updates.push(...updates.map(({ content, ...update }) => structuredClone(update)));
      taskUpdateJournal.acceptedRevision += updates.length; taskUpdateJournal.driverGeneration = driverGeneration;
    } else if (taskUpdateJournal) throw continuityError("continuity_source_unproven", "Durable task update acceptance requires its exact update facts.");
    if (input.logicalWorkId === ref.logicalWorkId) {
      if (taskUpdateJournal) predecessor.taskUpdateJournal = taskUpdateJournal;
      return;
    }
    if (draft.works[input.logicalWorkId] || lineage.headLogicalWorkId !== predecessor.logicalWorkId) throw continuityError("continuity_source_unproven");
    const oldAttempt = predecessor.attempts[ref.attempt]!;
    oldAttempt.writerRetired = true;
    const taskRevision = ++lineage.acceptedTaskRevision;
    if (input.contextCoverage) for (const entry of draft.contextCoverage ?? []) {
      if (entry.workLineageId === predecessor.workLineageId) entry.sourceTaskRevision = taskRevision;
    }
    lineage.headLogicalWorkId = input.logicalWorkId;
    lineage.taskMappings[recoveryDigest([input.localSessionId, input.localTaskRevision])] = taskRevision;
    const next = { attempt: 0, epoch: draft.epoch, historyRevision: draft.historyRevision,
      snapshotVersion: oldAttempt.snapshotVersion, snapshotDigest: input.snapshotDigest,
      stage: "accepted" as const, dispatchProtocolComplete: true, writerRetired: false,
      ...(oldAttempt.launcherInstance ? { launcherInstance: structuredClone(oldAttempt.launcherInstance) } : {}) };
    draft.works[input.logicalWorkId] = { logicalWorkId: input.logicalWorkId, instructionIdentity: input.instructionIdentity,
      nativeTurnId: input.nativeTurnId, workPayloadDigest: input.workPayloadDigest, purpose: "ordinary", state: "active",
      workLineageId: predecessor.workLineageId, acceptedTaskRevision: taskRevision,
      ...(taskUpdateJournal ? { taskUpdateJournal } : {}),
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
