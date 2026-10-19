import { observeRetainedCompaction } from "./continuity-compaction";
import { createHash, randomBytes } from "node:crypto";
import { estimateTokens } from "../../lib/token-estimate";
import type { CodexMessage, CodexParsedRequest, CodexProviderConfig } from "../../types";
import { buildCompactV1Output, COMPACT_PROMPT, extractCompactUserMessages } from "../../responses/compaction";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { assertLauncherContinuityCapacity, inspectLauncherContinuityConversation,
  markLauncherContinuitySendPossible, readLauncherContinuityInstance, retireLauncherContinuityWriter } from "../../launcher-browser-host";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "./adapter-error";
import { canonicalJson } from "./canonical-json";
import type { ChatGptBrowserWorker } from "./browser-worker";
import { canonicalizeCompactionHandoff, existingStructuredCompactionRun, MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  runStructuredCompactionOnce, withCompactionAbort } from "./compaction-handoff";
import { continuityCheckpoint, continuityDigest, continuitySourceRepresentationDigest, continuityCompactionSourceHistory,
  type ContinuityBinding, type ContinuityBindings, type ContinuityClaim } from "./continuity-binding";
import { sameContinuityLauncherInstance, sameContinuityRecoveryIdentity, type ContinuityLease } from "./continuity-contract";
import { chatGptConversationKey } from "./conversation-key";
import { continuityError } from "./continuity-errors";
import { compactionSourceWasDelegation, CONTINUITY_DELEGATION_SOURCE, CONTINUITY_IDENTITY_ONLY_SOURCE, isAcceptedCompactionContinuation, isDurableCompactionSourceIdentity } from "./compaction-continuation";
import { selectRecoveryContinuation } from "./continuity-recovery-continuation";
import { assertContinuityCompiledInput } from "./continuity-input";
import type { PreparedContinuityRequest } from "./continuity-request";
import { beginRecoveryAcquisition, beginRecoverySend, evictOptionalRecoveryResults, recoveryCanonicalResults, recoveryContext, recoveryDigest, recoveryFinalReceipt, recoveryIdentity, recoveryResultDigest, settleRecoveryKnownUnsent, settleRecoverySend, type RuntimeRecoverySendReference } from "./continuity-recovery-runtime";
import { continuityProcessInstance, type RecoveryCheckpointRecord, type RecoveryCompactionTarget,
  MAX_CONTINUITY_RECOVERY_ITEM_BYTES, type ContinuityRecoveryStore, type RecoveryThreadRecord, type RecoveryWorkRecord } from "./continuity-recovery-store";
import { chatGptCurrentInstructionIndex, extractChatGptCompactionSourceRevision, extractChatGptCompactV1SourceRevision,
  extractChatGptTurnIdentity, continuityCheckpointSiblings, continuityCheckpointSiblingGroup, continuityCheckpointSiblingProof, CONTINUITY_CHECKPOINT_SIBLING_PROOF, type ChatGptTurnUserRevision } from "./environment";
import type { ChatGptWebCapabilities } from "./model";
import { structuredCompactionHandoffInstruction } from "./native-compaction-control";
import { CompactionSourceCoverage, assertCompactionReadable, compactionAvailableTokens, compactionSourceInstruction, compactionSourcePageCost, previewRetainedCompactionSource, registerCompactionSource } from "./compaction-context";
import { createContextSnapshot, type ContextSnapshot } from "./context-snapshot";
import type { CompiledChatGptWebPrompt } from "./prompt";
import { TurnBroker, type TurnBrokerOwner } from "./turn-broker";
import { assertContinuityToolResultReplayEvidence, chatGptContinuityInstructionPayloadDigest, chatGptTurnExecutionKey, chatGptTurnSessions, type ChatGptTurnRuntime } from "./turn-execution";

export type StartManualRecoveryCompaction = (options: {
  traceId: string; sourceSnapshot: ContextSnapshot; deadlineAt: number;
  verifyCompleteSource: (snapshot: ContextSnapshot) => void; signal: AbortSignal;
}) => ChatGptTurnRuntime;

interface CompactionSelection {
  target: RecoveryCompactionTarget;
  source: RecoveryWorkRecord;
  sourceRevision: ChatGptTurnUserRevision;
  checkpoint?: RecoveryCheckpointRecord;
}
interface RecoveryCompactionPlan extends CompactionSelection {
  mode: "replay" | "recover" | "observe";
  observedRun?: Promise<string>;
  input?: CodexParsedRequest;
  sourceSnapshot?: ContextSnapshot;
  summary?: string;
  acceptedHandoff?: string;
  acceptedHandoffIdentity?: import("./continuity-contract").ContinuityRecoveryIdentity;
  sourceExecutionKey?: string;
  sourceBinding?: ContinuityBinding;
  preserveFinalResponse: boolean;
}
const preparedPlans = new WeakMap<PreparedContinuityRequest, RecoveryCompactionPlan>();
const freshPageCompactions = new WeakSet<CodexParsedRequest>();
const requestTargets = new WeakMap<CodexParsedRequest, CompactionSelection>();
interface HealthyCompactionObserver {
  logicalWorkId: string;
  attempt: number;
  epoch: number;
  snapshotVersion: number;
  transactionId: string;
  transactionVersion: number;
}
const healthyObservers = new WeakMap<PreparedContinuityRequest, HealthyCompactionObserver>();
const healthySends = new WeakMap<PreparedContinuityRequest, RuntimeRecoverySendReference>();

function retainHealthyObserver(prepared: PreparedContinuityRequest, work: RecoveryWorkRecord): void {
  const attempt = work.attempts.at(-1)!;
  healthyObservers.set(prepared, { logicalWorkId: work.logicalWorkId, attempt: attempt.attempt,
    epoch: attempt.epoch, snapshotVersion: attempt.snapshotVersion,
    transactionId: attempt.transactionId!, transactionVersion: attempt.transactionVersion! });
}
export function assertHealthyRecoveryCompactionAuthority(prepared: PreparedContinuityRequest): void {
  const observer = healthyObservers.get(prepared);
  if (!observer) return;
  const record = prepared.bindings.recoveryStore.get(prepared.binding.thread)!;
  const work = record.works[observer.logicalWorkId];
  if (work?.state === "stopped") throw continuityError("continuity_stopped");
  const attempt = work?.attempts.at(-1);
  const sourceId = work?.compactionTargetId ? record.compactionTargets[work.compactionTargetId]?.sourceLogicalWorkId : undefined;
  if (!work || work.state === "completed" || !attempt || attempt.attempt !== observer.attempt
    || attempt.epoch !== observer.epoch || record.epoch !== observer.epoch
    || attempt.snapshotVersion !== observer.snapshotVersion || attempt.transactionId !== observer.transactionId
    || attempt.transactionVersion !== observer.transactionVersion || record.owner.id !== prepared.bindings.owner
    || record.currentWorkId !== (work.activationState === "shadow" ? sourceId : observer.logicalWorkId)) {
    throw continuityError("continuity_source_unproven", "The healthy handoff belongs to an obsolete compaction attempt.");
  }
}

function sourcePayloadRepresentation(digest: string): string {
  return continuityDigest(["continuity-compaction-source-payload", digest]);
}
const REQUEST_CONTEXT_SOURCE = continuityDigest("continuity-request-context-source-v1");
function requestContextRepresentation(parsed: CodexParsedRequest): string {
  return continuityDigest(["continuity-request-context", continuityCompactionSourceHistory(parsed)]);
}
function registerTarget(store: ContinuityRecoveryStore, directory: string, record: RecoveryThreadRecord,
  input: Parameters<ContinuityRecoveryStore["registerCompactionTarget"]>[2], retainRequiredInput?: () => void,
  initialSiblingProof = false): RecoveryThreadRecord {
  const register = (current: RecoveryThreadRecord) => {
    if (initialSiblingProof) {
      const existing = Object.values(current.compactionTargets).find(target => target.sourceLogicalWorkId === input.sourceLogicalWorkId
        && target.acceptedTaskRevision === input.acceptedTaskRevision && target.sourceHistoryRevision === input.sourceHistoryRevision
        && target.sourceToolBatchHeadSequence === input.sourceToolBatchHeadSequence);
      // Capacity reconciliation may have observed a competing first target. The
      // store's representation-union API must not authenticate another sibling set.
      if (existing && (existing.sourceIdentity !== input.sourceIdentity
        || input.representationDigests?.some(value => !existing.representationDigests.includes(value)))) {
        throw continuityError("continuity_source_unproven", "The first compaction sibling proof was already fixed by another request.");
      }
    }
    return store.registerCompactionTarget(current.thread, { scope: current.scope, expectedVersion: current.version }, input);
  };
  try { return register(record); }
  catch (error) {
    if ((error as { code?: string })?.code !== "continuity_resource_capacity") throw error;
    retainRequiredInput?.();
    evictOptionalRecoveryResults(directory);
    const current = store.get(record.thread)!;
    return register(current);
  }
}
function currentCompactionResults(parsed: CodexParsedRequest): Record<string, unknown>[] {
  const input = (parsed._rawBody as { input: unknown[] }).input;
  return recoveryCanonicalResults({ ...parsed, _rawBody: { input: input.slice(chatGptCurrentInstructionIndex(parsed) + 1) } });
}
function sourceSiblingPrevious(parsed: CodexParsedRequest, record: RecoveryThreadRecord, source: RecoveryWorkRecord) {
  const previous = source.instructionPrevious;
  if (!previous?.checkpointDigest || source.allowRetainedSourceFallback
    || extractChatGptCompactionSourceRevision(parsed).turnId !== undefined) return previous;
  const proof = continuityCheckpoint(parsed);
  if (proof.index < 0 || proof.digest !== previous.checkpointDigest) return previous;
  const matches = Object.values(record.checkpoints).filter(checkpoint => checkpoint.summaryDigest === previous.checkpointDigest
    && checkpoint.targetHistoryRevision === source.attempts[0]?.historyRevision
    && checkpoint.sourceIdentity === previous.instructionIdentity);
  const checkpoint = matches.length === 1 ? matches[0] : undefined;
  const predecessor = checkpoint && record.works[checkpoint.sourceLogicalWorkId];
  if (!checkpoint || !predecessor || predecessor.instructionIdentity !== previous.instructionIdentity
    || predecessor.nativeTurnId !== previous.nativeTurnId || predecessor.acceptedTaskRevision !== checkpoint.acceptedTaskRevision
    || predecessor.workLineageId !== checkpoint.workLineageId || source.instructionIdentity === checkpoint.sourceIdentity
    || proof.index >= chatGptCurrentInstructionIndex(parsed)) {
    return previous;
  }
  // The accepted work records this boundary. A matching request summary alone
  // cannot authorize an unowned native window or hide additional task siblings.
  return { ...previous, trustedLowerBound: proof.index };
}
function sourcePayloadDigest(parsed: CodexParsedRequest, source: RecoveryWorkRecord): string {
  if (source.allowRetainedSourceFallback && isDurableCompactionSourceIdentity(parsed, extractChatGptCompactionSourceRevision(parsed))) {
    // Hash only the actual request-carried producer projection. Removing recognition
    // from this read-only projection prevents the identity placeholder becoming body.
    return chatGptContinuityInstructionPayloadDigest({ ...parsed, _continuityScope: undefined });
  }
  return chatGptContinuityInstructionPayloadDigest(parsed, source.instructionPrevious, source.allowRetainedSourceFallback ?? false);
}
function assertEndedManualResults(parsed: CodexParsedRequest, record: RecoveryThreadRecord, source: RecoveryWorkRecord): void {
  if (!isChatGptWebZeroRiskBackendModel(parsed.modelId) || source.state !== "completed") return;
  for (const result of currentCompactionResults(parsed)) {
    const call = record.calls[String(result.call_id)];
    if (!call || call.workLineageId !== source.workLineageId || call.state !== "settled" || call.expectedResultType !== result.type) {
      throw continuityError("continuity_source_unproven", "The manual checkpoint contains a result outside its accepted source calls.");
    }
  }
}
function assertSourcePayload(parsed: CodexParsedRequest, source: RecoveryWorkRecord, record: RecoveryThreadRecord, target?: RecoveryCompactionTarget): void {
  const payload = sourcePayloadDigest(parsed, source);
  if (payload !== source.workPayloadDigest && !target?.representationDigests.includes(sourcePayloadRepresentation(payload))) {
    const revision = extractChatGptCompactionSourceRevision(parsed);
    const continuation = continuedDelegation(parsed, record, revision);
    if (isDurableCompactionSourceIdentity(parsed, revision) && continuation?.work.logicalWorkId === source.logicalWorkId
      && continuation.checkpoint.representationDigests.includes(sourcePayloadRepresentation(payload))) return;
    throw continuityError("continuity_source_unproven", "The source instruction group conflicts with its first accepted payload.");
  }
}

function sourceIdentity(parsed: CodexParsedRequest, source: ChatGptTurnUserRevision): string {
  const identity = extractChatGptTurnIdentity(parsed);
  return source.itemId ? parsed._chatGptMessageIdAliases?.[source.itemId] ?? source.itemId
    : `turn:${source.turnId ?? identity.turnId}`;
}
function sourceRevisions(parsed: CodexParsedRequest, record: RecoveryThreadRecord): number[] {
  if (freshPageCompactions.has(parsed)) return [0];
  const contexts = Object.values(record.compactionTargets).filter(target => target.representationDigests.includes(REQUEST_CONTEXT_SOURCE)
    && target.representationDigests.includes(requestContextRepresentation(parsed)));
  if (contexts.length) return [...new Set(contexts.map(target => target.sourceHistoryRevision))];
  const checkpoint = continuityCheckpoint(parsed);
  if (checkpoint.index < 0) return [0];
  const matches = Object.values(record.checkpoints).filter(value => value.summaryDigest === checkpoint.digest);
  if (!matches.length) throw continuityError("continuity_source_unproven", "The supplied checkpoint has no committed history relation.");
  return [...new Set(matches.map(value => value.targetHistoryRevision))];
}

/** Resolve actual source/call relations. Similar text and the latest thread head are not selectors. */
export function selectRecoveryCompactionTarget(parsed: CodexParsedRequest, record: RecoveryThreadRecord): CompactionSelection | undefined {
  const sourceRevision = extractChatGptCompactionSourceRevision(parsed);
  const identity = sourceIdentity(parsed, sourceRevision);
  const representation = continuitySourceRepresentationDigest(parsed, sourceRevision);
  const revisions = sourceRevisions(parsed, record);
  const selectedResults = currentCompactionResults(parsed);
  const calls = selectedResults.flatMap(item => record.calls[String(item.call_id)] ?? []);
  let targets = Object.values(record.compactionTargets).filter(target => revisions.includes(target.sourceHistoryRevision)
    && (target.sourceIdentity === identity || target.representationDigests.includes(representation)));
  if (calls.length) {
    targets = targets.filter(target => {
      const related = calls.filter(call => call.workLineageId === target.workLineageId);
      if (!related.length) return false;
      const selectedSequence = Math.max(...related.map(call => call.batchSequence));
      return selectedSequence === target.sourceToolBatchHeadSequence
        || record.works[target.sourceLogicalWorkId]?.state === "completed"
          && related.every(call => call.state === "settled" && call.batchSequence < target.sourceToolBatchHeadSequence);
    });
  }
  if (targets.length > 1) throw continuityError("continuity_source_unproven", "The request cannot distinguish its durable compaction targets.");
  const target = targets[0];
  if (!target) return undefined;
  if (!target.representationDigests.includes(representation)) {
    throw continuityError("continuity_source_unproven", "The source identity carries a different accepted compaction payload.");
  }
  const source = record.works[target.sourceLogicalWorkId];
  if (!source || source.purpose !== "ordinary" || source.workLineageId !== target.workLineageId
    || source.acceptedTaskRevision !== target.acceptedTaskRevision) {
    throw continuityError("continuity_source_unproven", "The compaction target has no accepted source work.");
  }
  assertSourcePayload(parsed, source, record, target);
  const requestContextSource = target.representationDigests.includes(REQUEST_CONTEXT_SOURCE);
  if (requestContextSource && !target.representationDigests.includes(requestContextRepresentation(parsed))) {
    throw continuityError("continuity_source_unproven", "The current context differs from its accepted compaction source.");
  }
  for (const value of (parsed._rawBody as { input: unknown[] }).input) {
    const proof = continuityCheckpointSiblingProof(parsed, value);
    if (proof?.identity && target.representationDigests.includes(proof.identity)
      && !target.representationDigests.includes(proof.representation)) {
      throw continuityError("continuity_source_unproven", "The compaction sibling conflicts with its first accepted source.");
    }
  }
  const siblings = continuityCheckpointSiblings(parsed, sourceSiblingPrevious(parsed, record, source));
  if (siblings.length && !target.representationDigests.includes(continuityCheckpointSiblingGroup(siblings))) {
    throw continuityError("continuity_source_unproven", "The compaction sibling group differs from its first accepted source.");
  }
  const checkpointDigest = continuityCheckpoint(parsed).digest;
  const covered = new Set(Object.values(record.checkpoints).find(checkpoint => checkpoint.summaryDigest === checkpointDigest
    && checkpoint.targetHistoryRevision === target.sourceHistoryRevision && checkpoint.workLineageId === target.workLineageId)?.coveredCallIds ?? []);
  for (const item of selectedResults) {
    const call = record.calls[String(item.call_id)];
    if (call?.workLineageId !== target.workLineageId || call.batchSequence !== target.sourceToolBatchHeadSequence) continue;
    if (covered.has(call.callId) && call.state === "settled") continue;
    if (item.type !== call.expectedResultType) {
      throw continuityError("continuity_source_unproven", "The compaction's selected result batch carries an unexpected result type.");
    }
    if (call.firstResultDigest && call.firstResultDigest !== recoveryResultDigest(item)) {
      throw continuityError("continuity_result_conflict", "The compaction's selected result batch differs from its first acceptance.");
    }
  }
  const checkpoint = Object.values(record.checkpoints).find(value => value.compactionTargetId === target.compactionTargetId);
  if (checkpoint && selectedResults.length && !requestContextSource) {
    const sourceCalls = Object.values(record.calls).filter(call => call.workLineageId === target.workLineageId);
    assertContinuityToolResultReplayEvidence(parsed, {
      results: sourceCalls.filter(call => call.batchSequence === target.sourceToolBatchHeadSequence
        && !(covered.has(call.callId) && call.state === "settled")).map(call => {
        if (!call.firstResultDigest) throw continuityError("continuity_source_unproven", "A committed compaction is missing its accepted result evidence.");
        return { callId: call.callId, type: call.expectedResultType, digest: call.firstResultDigest };
      }),
      earlierCallIds: sourceCalls.filter(call => call.batchSequence < target.sourceToolBatchHeadSequence).map(call => call.callId),
    }, new Set(sourceCalls.filter(call => covered.has(call.callId) && call.state === "settled").map(call => call.callId)));
  }
  return { target, source, sourceRevision, ...(checkpoint ? { checkpoint } : {}) };
}

function continuedDelegation(parsed: CodexParsedRequest, record: RecoveryThreadRecord, source: ChatGptTurnUserRevision) {
  const identity = sourceIdentity(parsed, source);
  if (compactionSourceWasDelegation(parsed, source)) {
    const continuation = selectRecoveryContinuation(parsed, record, extractChatGptTurnIdentity(parsed));
    // The exact checkpoint selects its source, or its recorded consumer once consumed.
    // That execution can keep the original delegated source's different native turn.
    if (continuation?.checkpoint.sourceIdentity === identity
      && isAcceptedCompactionContinuation(parsed, extractChatGptTurnIdentity(parsed), source)) {
      return continuation;
    }
  }
  return undefined;
}

function selectSource(parsed: CodexParsedRequest, record: RecoveryThreadRecord): RecoveryWorkRecord {
  const source = extractChatGptCompactionSourceRevision(parsed);
  const identity = sourceIdentity(parsed, source);
  const continuation = continuedDelegation(parsed, record, source);
  if (continuation) return continuation.work;
  let matching = Object.values(record.works).filter(work => work.purpose === "ordinary"
    && work.instructionIdentity === identity && (!source.turnId || work.nativeTurnId === source.turnId));
  if (matching.length > 1) {
    const revisions = sourceRevisions(parsed, record);
    matching = matching.filter(work => revisions.includes(work.attempts[0]!.historyRevision));
  }
  if (matching.length !== 1) throw continuityError("continuity_source_unproven", "The compaction request does not identify one accepted ordinary source.");
  return matching[0]!;
}

function retainedSummary(binding: ContinuityBinding | undefined, checkpoint: RecoveryCheckpointRecord): string | undefined {
  const committed = [...binding?.checkpoints.values() ?? []].find(value => value.sourceRevision === checkpoint.sourceHistoryRevision
    && value.revision === checkpoint.targetHistoryRevision && continuityDigest(value.summary) === checkpoint.summaryDigest)?.summary;
  if (committed) return committed;
  const accepted = binding?.acceptedHandoff;
  return accepted?.sourceRevision === checkpoint.sourceHistoryRevision && continuityDigest(accepted.summary) === checkpoint.summaryDigest
    ? accepted.summary : undefined;
}
function compactionKey(namespace: string, target: RecoveryCompactionTarget): string {
  return `${namespace}:continuity-compaction:${target.compactionTargetId}`;
}
function compactPrompt(parsed: CodexParsedRequest): string {
  if (parsed._compactionOutput !== "message") return COMPACT_PROMPT;
  const message = parsed.context.messages.at(-1);
  if (message?.role !== "user") throw continuityError("continuity_source_unproven", "The local compaction instruction is absent.");
  const text = typeof message.content === "string" ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  if (!text.trim()) throw continuityError("continuity_source_unproven", "The local compaction instruction is empty.");
  return text;
}
function compactionPayloadDigest(parsed: CodexParsedRequest, target: RecoveryCompactionTarget): string {
  return continuityDigest({ compactionTargetId: target.compactionTargetId, control: compactPrompt(parsed) });
}

/** Admit the actual cold compaction entry. Source bytes are validated separately. */
export function compileRecoveryCompactionInput(parsed: CodexParsedRequest, capabilities: ChatGptWebCapabilities,
  transaction: { token: string; handoffId: string }, snapshot = createContextSnapshot(parsed)): CompiledChatGptWebPrompt {
  const instruction = structuredCompactionHandoffInstruction(transaction, compactPrompt(parsed));
  const compiled = { text: compactionSourceInstruction(snapshot, instruction, compactionAvailableTokens(parsed, capabilities, 0)), images: [] };
  assertContinuityCompiledInput(compiled, { ...parsed, context: { ...parsed.context, messages: [] } }, capabilities,
    (transaction.token.length + transaction.handoffId.length + 42) * 2);
  return compiled;
}

/** A closed/unknown source is supplied by this request, never by an old task ledger. */
export async function prepareFreshRecoveryCompaction(parsed: CodexParsedRequest, provider: CodexProviderConfig,
  namespace: string, capabilities: ChatGptWebCapabilities, worker: ChatGptBrowserWorker,
  bindings: ContinuityBindings, descriptor: string, abortSignal?: AbortSignal,
  assertExecutionCompatible?: () => Promise<void>): Promise<PreparedContinuityRequest> {
  await assertExecutionCompatible?.();
  abortSignal?.throwIfAborted();
  const source = extractChatGptCompactionSourceRevision(parsed);
  const native = extractChatGptTurnIdentity(parsed);
  const epoch = Number.parseInt(randomBytes(6).toString("hex"), 16);
  parsed._continuityPageGeneration = epoch;
  parsed._continuityEpoch = epoch; parsed._continuityAttempt = 0; parsed._continuityHistoryRevision = 0;
  const logicalWorkId = recoveryDigest([parsed._continuityScope, sourceIdentity(parsed, source), "source", epoch]);
  const store = bindings.recoveryStore;
  let record = store.admitWork({ thread: continuityDigest(native.threadId!), scope: parsed._continuityScope!,
    owner: continuityProcessInstance(bindings.owner), logicalWorkId, instructionIdentity: sourceIdentity(parsed, source),
    nativeTurnId: source.turnId ?? native.turnId, workPayloadDigest: chatGptContinuityInstructionPayloadDigest(parsed),
    snapshotDigest: recoveryDigest(parsed.context), createPage: false, dispatchProtocolComplete: true, initialEpoch: epoch });
  // This source is context, never an executable replacement of its historical calls.
  record = store.retireAttempt(record.thread, { scope: record.scope, expectedVersion: record.version }, logicalWorkId, 0);
  freshPageCompactions.add(parsed);
  const prepared = await prepareRecoveryCompaction(parsed, provider, namespace, capabilities, worker, bindings, record,
    descriptor, abortSignal, assertExecutionCompatible);
  if (!prepared) throw continuityError("continuity_context_missing", "The current request cannot form a readable compaction source.");
  return prepared;
}

/** Called before retained-page checks so completed results and confirmed loss remain recoverable. */
export async function prepareRecoveryCompaction(parsed: CodexParsedRequest, provider: CodexProviderConfig,
  namespace: string, capabilities: ChatGptWebCapabilities, worker: ChatGptBrowserWorker,
  bindings: ContinuityBindings, record: RecoveryThreadRecord | undefined, descriptor: string,
  abortSignal?: AbortSignal, assertExecutionCompatible?: () => Promise<void>,
  existingTargetId?: string): Promise<PreparedContinuityRequest | undefined> {
  if (!parsed._compactionRequest) return undefined;
  if (!record) throw continuityError("continuity_source_unproven", "A standalone compaction cannot activate a continuity thread.");
  if (record.legacyUnproven) throw continuityError("continuity_legacy_unproven");
  if (record.scope !== parsed._continuityScope) throw continuityError("continuity_configuration_conflict");
  abortSignal?.throwIfAborted();
  const store = bindings.recoveryStore;
  record = store.get(record.thread)!;
  let retainedInput: CodexParsedRequest | undefined;
  let selection = selectRecoveryCompactionTarget(parsed, record);
  // A stale preview may observe its original target, but cannot admit a new writer.
  if (existingTargetId && selection?.target.compactionTargetId !== existingTargetId) return undefined;
  if (!selection) {
    const source = selectSource(parsed, record);
    assertSourcePayload(parsed, source, record);
    assertEndedManualResults(parsed, record, source);
    const lineage = record.lineages[source.workLineageId];
    const revisions = sourceRevisions(parsed, record);
    if (!lineage || revisions.length !== 1 || revisions[0] !== record.historyRevision) {
      throw continuityError("continuity_source_unproven", "No unique current history target can be proved.");
    }
    const sourceRevision = extractChatGptCompactionSourceRevision(parsed);
    const results = currentCompactionResults(parsed).flatMap(item => record!.calls[String(item.call_id)] ?? [])
      .filter(call => call.workLineageId === source.workLineageId);
    // A completed source's older result echo does not select an obsolete batch. Its
    // accepted final boundary retains the complete issued-batch relation.
    const sequence = source.state === "completed" || !results.length ? lineage.toolBatchHeadSequence
      : Math.max(...results.map(call => call.batchSequence));
    // A new target needs the accepted source and its actual batch, not a request-selected latest head.
    if (lineage.headLogicalWorkId !== source.logicalWorkId || sequence !== lineage.toolBatchHeadSequence) {
      throw continuityError("continuity_source_unproven", "The selected source batch is not an accepted current compaction boundary.");
    }
    await assertExecutionCompatible?.();
    abortSignal?.throwIfAborted();
    const afterCompatibility = store.get(record.thread)!;
    if (afterCompatibility.version !== record.version) {
      return prepareRecoveryCompaction(parsed, provider, namespace, capabilities, worker, bindings, afterCompatibility,
        descriptor, abortSignal, assertExecutionCompatible);
    }
    const siblings = continuityCheckpointSiblings(parsed, sourceSiblingPrevious(parsed, record, source));
    record = registerTarget(store, bindings.registrations.directory, record, {
      sourceLogicalWorkId: source.logicalWorkId, sourceIdentity: sourceIdentity(parsed, sourceRevision),
      acceptedTaskRevision: source.acceptedTaskRevision, sourceHistoryRevision: revisions[0],
      sourceToolBatchHeadSequence: sequence, representationDigests: [continuitySourceRepresentationDigest(parsed, sourceRevision),
        sourcePayloadRepresentation(source.workPayloadDigest), sourcePayloadRepresentation(sourcePayloadDigest(parsed, source)), CONTINUITY_CHECKPOINT_SIBLING_PROOF,
        ...(freshPageCompactions.has(parsed) ? [REQUEST_CONTEXT_SOURCE, requestContextRepresentation(parsed)] : []),
        continuityCheckpointSiblingGroup(siblings), ...siblings.flatMap(proof => proof.identity ? [proof.identity, proof.representation] : [proof.representation])],
      checkpointBytes: MAX_CONTINUITY_RECOVERY_ITEM_BYTES,
    }, () => {
      const checkpointDigest = continuityCheckpoint(parsed).digest;
      const covered = Object.values(record!.checkpoints).find(value => value.summaryDigest === checkpointDigest
        && value.targetHistoryRevision === revisions[0] && value.workLineageId === source.workLineageId);
      retainedInput = recoveryContext(parsed, { directory: bindings.registrations.directory,
        thread: record!.thread, logicalWorkId: source.logicalWorkId, attempt: source.attempts.at(-1)!.attempt }, covered?.commitId);
    }, true);
    selection = selectRecoveryCompactionTarget(parsed, record);
    if (!selection) throw continuityError("continuity_source_unproven");
  }
  assertEndedManualResults(parsed, record, selection.source);
  requestTargets.set(parsed, selection);
  parsed._continuityHistoryRevision = selection.target.sourceHistoryRevision;
  parsed._continuityEpoch = record.epoch;
  const observed = bindings.observed(record.thread);
  const executionKey = compactionKey(namespace, selection.target);
  const previousCompaction = record.works[`compaction:${selection.target.compactionTargetId}`];
  if (previousCompaction && previousCompaction.workPayloadDigest !== compactionPayloadDigest(parsed, selection.target)) {
    throw continuityError("continuity_source_unproven", "The compaction control conflicts with its first accepted request.");
  }
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) throw continuityError("continuity_source_unproven");
  if (selection.checkpoint) {
    const summary = retainedSummary(observed, selection.checkpoint);
    const cached = existingStructuredCompactionRun<string>(executionKey);
    if (!summary && !cached) throw continuityError("continuity_replay_unavailable", "The completed compaction body was reclaimed; it cannot be regenerated.");
    const binding = observed ?? bindings.installRecovered(record, executionKey, continuityCheckpoint(parsed).digest, identity.turnId);
    parsed._continuityEpoch = binding.epoch;
    const prepared: PreparedContinuityRequest = { bindings, binding, descriptor, executionKey,
      conversationKey: chatGptConversationKey(parsed, namespace)!, nativeThreadId: identity.threadId,
      revision: selection.target.sourceHistoryRevision };
    preparedPlans.set(prepared, { ...selection, mode: "replay", summary, observedRun: cached,
      preserveFinalResponse: Boolean(selection.checkpoint.ordinaryFinalReceiptId) });
    return prepared;
  }
  if (selection.source.state === "stopped" || record.works[`compaction:${selection.target.compactionTargetId}`]?.state === "stopped") {
    throw continuityError("continuity_stopped");
  }
  // A network observer attaches to the existing transaction. It never retires that writer.
  const observedRun = existingStructuredCompactionRun<string>(executionKey, compactionPayloadDigest(parsed, selection.target), {
    ownerKey: `${namespace}:continuity-recovery:${record.thread}:${parsed._continuityPageGeneration}`,
    traceIds: [createHash("sha256").update(`${executionKey}:recovery-handoff`).digest("hex").slice(0, 12)],
    nativeThreadId: identity.threadId, nativeTurnId: identity.turnId,
  });
  if (observedRun) {
    const binding = observed ?? bindings.installRecovered(record, executionKey, continuityCheckpoint(parsed).digest, identity.turnId);
    const prepared: PreparedContinuityRequest = { bindings, binding, descriptor, executionKey,
      conversationKey: binding.conversation?.key ?? chatGptConversationKey(parsed, namespace)!, nativeThreadId: identity.threadId,
      revision: selection.target.sourceHistoryRevision };
    preparedPlans.set(prepared, { ...selection, mode: "observe", observedRun, preserveFinalResponse: selection.source.state === "completed" });
    return prepared;
  }
  if (existingTargetId) {
    const retainedKey = `${namespace}:${chatGptTurnExecutionKey(parsed)}`;
    if (!observed?.compactionKey || observed.compactionKey !== retainedKey) return undefined;
    const prepared: PreparedContinuityRequest = { bindings, binding: observed, descriptor, executionKey: retainedKey,
      conversationKey: observed.conversation?.key ?? chatGptConversationKey(parsed, namespace)!, nativeThreadId: identity.threadId,
      revision: selection.target.sourceHistoryRevision, sourceExecutionKey: observed.executionKey };
    const retainedRun = observeRetainedCompaction(parsed, prepared, namespace);
    if (!retainedRun) return undefined;
    // A preflight observer can disconnect before runTurn attaches its error handler.
    void retainedRun.catch(() => {});
    preparedPlans.set(prepared, { ...selection, mode: "observe", observedRun: retainedRun,
      preserveFinalResponse: selection.source.state === "completed" });
    return prepared;
  }
  const healthy = observed && ["running", "ready", "compacting"].includes(observed.state)
    && ["running", "ready", "compacting"].includes(record.state) && observed.lease && record.owner.id === bindings.owner;
  const endedManual = isChatGptWebZeroRiskBackendModel(parsed.modelId) && selection.source.state === "completed";
  // Public compact is the explicit manual request. An ended source needs a new
  // control-only owner; an active source keeps its original handoff boundary.
  if (healthy && !endedManual) {
    const source = observed.executionKey ? chatGptTurnSessions.find(observed.executionKey) : undefined;
    const coverage = source?.runtime.compactionSourceCoverage;
    // A recovered checkpoint retires its ordinary writer and clears the live key.
    // Only its exact identity-only delegation relation can use recovery again here.
    const retiredDelegation = !observed.executionKey
      && isDurableCompactionSourceIdentity(parsed, selection.sourceRevision)
      && continuedDelegation(parsed, record, selection.sourceRevision)?.work.logicalWorkId === selection.source.logicalWorkId;
    if ((!source || !coverage) && !retiredDelegation) return undefined;
    if (source && coverage) {
      await source.runtime.syncContextUsage?.();
      // A concurrent commit can reclaim the source coverage during the usage wait.
      // Let the caller revalidate the original identity before reading that old source.
      const afterUsage = store.get(record.thread);
      if (afterUsage?.historyRevision !== record.historyRevision || afterUsage.currentWorkId !== record.currentWorkId) return undefined;
      // The ordinary final can win while this active-source preview waits. Keep
      // that result on the retained path; this request did not start an ended turn.
      if (isChatGptWebZeroRiskBackendModel(parsed.modelId)
        && afterUsage.works[selection.source.logicalWorkId]?.state === "completed") return undefined;
      const preview = previewRetainedCompactionSource(parsed, source);
      const snapshot = preview.snapshot;
      const pageTokens = Math.max(observed.retainedPageTokens ?? 0, preview.coverage.pageTokenReserve());
      const available = compactionAvailableTokens(parsed, capabilities, pageTokens);
      try {
        const control = structuredCompactionHandoffInstruction({ token: `control_${"0".repeat(32)}`,
          handoffId: `handoff_${"0".repeat(32)}` }, compactPrompt(parsed));
        const instruction = compactionSourceInstruction(snapshot, control, available);
        await assertCompactionReadable(snapshot, available - Math.max(8_192, estimateTokens(instruction)));
        return undefined;
      } catch (error) {
        if ((error as { code?: string }).code !== "continuity_input_limit") throw error;
        // An otherwise healthy page may fit ordinary work but lack the independent
        // checkpoint reading and summary allowance. Admit the actual cold plan below.
      }
    }
  }
  await assertExecutionCompatible?.();
  abortSignal?.throwIfAborted();
  const afterCompatibility = store.get(record.thread)!;
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId) && !endedManual
    && afterCompatibility.works[selection.source.logicalWorkId]?.state === "completed") return undefined;
  if (afterCompatibility.version !== record.version) {
    return prepareRecoveryCompaction(parsed, provider, namespace, capabilities, worker, bindings, afterCompatibility,
      descriptor, abortSignal, assertExecutionCompatible);
  }
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId) && !endedManual && !freshPageCompactions.has(parsed)) throw continuityError("continuity_manual_handoff_required");
  const sourceAttempt = selection.source.attempts.at(-1);
  if (!sourceAttempt) throw continuityError("continuity_source_unproven");
  const accepted = observed?.acceptedHandoff;
  const acceptedHandoff = accepted && accepted.sourceRevision === selection.target.sourceHistoryRevision
    && (accepted.sourceExecutionKey === observed?.executionKey || accepted.key === executionKey)
    ? canonicalizeCompactionHandoff(parsed, accepted.summary) : undefined;
  const acceptedHandoffIdentity = acceptedHandoff ? accepted?.lease.recovery : undefined;
  if (!acceptedHandoff && previousCompaction?.attempts.at(-1)?.stage === "send-possible") {
    throw continuityError("continuity_execution_unsettled", "The original compaction Send has no verified submission result.");
  }
  if (acceptedHandoff && (!acceptedHandoffIdentity || acceptedHandoffIdentity.logicalWorkId !== previousCompaction?.logicalWorkId
    || acceptedHandoffIdentity.attempt !== previousCompaction.attempts.at(-1)!.attempt
    || acceptedHandoffIdentity.epoch !== previousCompaction.attempts.at(-1)!.epoch
    || acceptedHandoffIdentity.snapshotVersion !== previousCompaction.attempts.at(-1)!.snapshotVersion)) {
    throw continuityError("continuity_source_unproven", "The accepted handoff has no matching original compaction attempt.");
  }
  const checkpointDigest = continuityCheckpoint(parsed).digest;
  const coveredCheckpoint = Object.values(record.checkpoints).find(checkpoint => checkpoint.summaryDigest === checkpointDigest
    && checkpoint.targetHistoryRevision === selection!.target.sourceHistoryRevision
    && checkpoint.workLineageId === selection!.target.workLineageId);
  const input = freshPageCompactions.has(parsed) ? structuredClone(parsed) : retainedInput ?? recoveryContext(parsed, { directory: bindings.registrations.directory,
    thread: record.thread, logicalWorkId: selection.source.logicalWorkId, attempt: sourceAttempt.attempt }, coveredCheckpoint?.commitId);
  let sourceSnapshot: ContextSnapshot | undefined;
  if (!acceptedHandoff) {
    const coveredCalls = new Set(coveredCheckpoint?.coveredCallIds ?? []);
    const sourceInput = structuredClone(input);
    sourceInput.context.messages = sourceInput.context.messages.flatMap<CodexMessage>(message => {
      if (message.role === "toolResult" && coveredCalls.has(message.toolCallId)) return [];
      if (message.role !== "assistant") return [message];
      return [{ ...message, content: message.content.filter(part => part.type !== "toolCall" || !coveredCalls.has(part.id)) }];
    });
    const raw = sourceInput._rawBody as { input: unknown[] };
    raw.input = raw.input.filter(item => !item || typeof item !== "object"
      || !("call_id" in item) || !coveredCalls.has(String(item.call_id)));
    sourceSnapshot = createContextSnapshot(sourceInput);
    const current = store.get(record.thread)!;
    const coverage = (current.contextCoverage ?? []).filter(entry => entry.workLineageId === selection!.target.workLineageId);
    if (coverage.some(entry => entry.metadata.historyRevision !== selection!.target.sourceHistoryRevision
      || entry.sourceTaskRevision > selection!.target.acceptedTaskRevision)) {
      throw continuityError("continuity_source_unproven", "The compaction target omits a newer accepted source boundary.");
    }
    const fullyCovered = coveredCheckpoint && coveredCheckpoint.acceptedTaskRevision === selection.target.acceptedTaskRevision
      && coveredCheckpoint.sourceToolBatchHeadSequence === selection.target.sourceToolBatchHeadSequence;
    // A committed checkpoint can represent its exact already-covered range. It does not
    // authorize unknown source material after that accepted revision/tool-batch boundary.
    if (!freshPageCompactions.has(parsed) && (coverage.length || !fullyCovered)) {
      CompactionSourceCoverage.assertRecordedSource(sourceSnapshot, coverage.map(entry => entry.metadata), selection.target.sourceHistoryRevision);
    }
  }
  // Check the selected entry and individual source reads without charging unread
  // task history as browser input. No credentials or page are created here.
  if (!acceptedHandoff) {
    const compiled = compileRecoveryCompactionInput(input, capabilities,
      { token: `control_${"0".repeat(32)}`, handoffId: `handoff_${"0".repeat(32)}` }, sourceSnapshot);
    await assertCompactionReadable(sourceSnapshot!, compactionAvailableTokens(input, capabilities, 0)
      - estimateTokens(compiled.text));
  }
  abortSignal?.throwIfAborted();
  const afterSourcePreparation = store.get(record.thread)!;
  if (afterSourcePreparation.version !== record.version) {
    return prepareRecoveryCompaction(parsed, provider, namespace, capabilities, worker, bindings, afterSourcePreparation,
      descriptor, abortSignal, assertExecutionCompatible);
  }
  // This coordinator verifies the target thread's retired authority, not merely a live PID.
  if (!freshPageCompactions.has(parsed) && observed?.lease) {
    const page = await inspectLauncherContinuityConversation(descriptor,
      observed.conversation?.key ?? chatGptConversationKey(parsed, namespace)!, observed.lease);
    if (page.state !== "ready" && page.state !== "running") throw continuityError("continuity_session_lost");
  }
  const { retireRecoveryWriter } = await import("./continuity-recovery-runtime");
  const currentCompaction = record.works[`compaction:${selection.target.compactionTargetId}`];
  const currentAttempt = currentCompaction?.attempts.at(-1);
  const waitingAcquisition = currentCompaction?.logicalWorkId === record.currentWorkId
    && record.owner.id === bindings.owner && currentAttempt?.stage === "prepared" && !currentAttempt.writerRetired
    && currentAttempt.acquisitionEvidence?.status === "not-acquired" && Boolean(currentAttempt.acquisitionEvidence.receiptId);
  if (waitingAcquisition && currentAttempt!.acquisitionEvidence!.identityDigest
    !== recoveryDigest(canonicalJson(recoveryIdentity(record, store.installationId())))) {
    throw continuityError("continuity_source_unproven", "The known unacquired retry no longer matches its original reservation.");
  }
  if (!waitingAcquisition && !freshPageCompactions.has(parsed)) record = await retireRecoveryWriter(bindings, record, descriptor);
  const shadow = record.works[`compaction:${selection.target.compactionTargetId}`];
  if (shadow?.activationState === "shadow") {
    const attempt = shadow.attempts.at(-1)!;
    record = store.activateCompaction(record.thread, { scope: record.scope, expectedVersion: record.version }, shadow.logicalWorkId, {
      attempt: attempt.attempt, snapshotVersion: attempt.snapshotVersion,
      transactionId: attempt.transactionId!, transactionVersion: attempt.transactionVersion!,
    });
  }
  abortSignal?.throwIfAborted();
  // A foreign backend's retired source is not this process's durable admission.
  // Keep preparation private until runRecoveryCompaction admits the new attempt,
  // then installRecovered publishes that exact owner/epoch through registration CAS.
  const binding: ContinuityBinding = observed ?? (record.owner.id === bindings.owner
    ? bindings.installRecovered(record, executionKey, continuityCheckpoint(parsed).digest, identity.turnId)
    : { thread: record.thread, scope: record.scope, owner: record.owner.id, epoch: record.epoch,
      initialExecutionKey: executionKey, executionKey, initialNativeTurnId: identity.turnId,
      state: "creating", revision: record.historyRevision, lastUsedAt: Date.now(),
      revisionDigests: new Map(), revisions: new Map(), checkpoints: new Map(), ordinaryReplayTombstones: new Map() });
  const prepared: PreparedContinuityRequest = { bindings, binding, descriptor, executionKey,
    conversationKey: chatGptConversationKey(parsed, namespace)!, nativeThreadId: identity.threadId,
    revision: selection.target.sourceHistoryRevision, sourceExecutionKey: observed?.executionKey };
  preparedPlans.set(prepared, { ...selection, mode: "recover", input, sourceSnapshot, acceptedHandoff, acceptedHandoffIdentity,
    sourceExecutionKey: observed?.executionKey, sourceBinding: observed,
    preserveFinalResponse: selection.source.state === "completed" });
  return prepared;
}

export function isRecoveryCompaction(prepared: PreparedContinuityRequest): boolean { return preparedPlans.has(prepared); }
export function recoveryCompactionTarget(parsed: CodexParsedRequest): CompactionSelection | undefined { return requestTargets.get(parsed); }

/** Authenticated lifecycle entry points persist stop before aborting the physical writer. */
export function assertRecoveryCompactionNotStopped(parsed: CodexParsedRequest, prepared: PreparedContinuityRequest): void {
  const selection = requestTargets.get(parsed) ?? preparedPlans.get(prepared);
  if (!selection) return;
  const record = prepared.bindings.recoveryStore.get(prepared.binding.thread);
  const work = record?.works[`compaction:${selection.target.compactionTargetId}`];
  // A committed checkpoint remains readable after a later stop on the same lineage.
  if (work?.state === "completed") return;
  if (work?.state === "stopped" || record?.works[selection.source.logicalWorkId]?.state === "stopped") {
    throw continuityError("continuity_stopped");
  }
}

export async function assertRecoveryCompactionResult(prepared: PreparedContinuityRequest): Promise<void> {
  const plan = preparedPlans.get(prepared);
  const record = prepared.bindings.recoveryStore.get(prepared.binding.thread);
  const checkpoint = plan && Object.values(record?.checkpoints ?? {}).find(value => value.compactionTargetId === plan.target.compactionTargetId);
  if (!checkpoint) throw continuityError("continuity_source_unproven", "The compaction has no durable success receipt.");
}

function representations(parsed: CodexParsedRequest, selection: CompactionSelection, summary: string): string[] {
  const raw = parsed._rawBody as { input: unknown[] };
  const sourceInput = parsed._compactionOutput === "message" ? raw.input.slice(0, -1) : raw.input;
  const producer = { ...parsed, _rawBody: { ...raw, input: buildCompactV1Output(extractCompactUserMessages(sourceInput), summary) },
    _compactionOutput: undefined };
  const payloads = [sourcePayloadRepresentation(sourcePayloadDigest(parsed, selection.source))];
  try { payloads.push(sourcePayloadRepresentation(sourcePayloadDigest(producer, selection.source))); }
  catch (error) {
    // v1 retains human user messages. A source with no such representation keeps its exact proof.
    if (!(error instanceof ChatGptWebAdapterError && error.code === "continuity_source_unproven")
      && !(error instanceof Error && error.message === "ChatGPT web compaction requires a source user message")) throw error;
  }
  return [...new Set([
    ...[selection.sourceRevision, extractChatGptCompactV1SourceRevision(parsed, summary)]
      .map(source => continuitySourceRepresentationDigest(parsed, source)),
    ...payloads,
    ...(compactionSourceWasDelegation(parsed, selection.sourceRevision) ? [CONTINUITY_DELEGATION_SOURCE] : []),
    ...(isDurableCompactionSourceIdentity(parsed, selection.sourceRevision) ? [CONTINUITY_IDENTITY_ONLY_SOURCE] : []),
  ])];
}

/** The durable commit is the success boundary. Page leases never stand in for this receipt. */
export function commitRecoveryCompaction(parsed: CodexParsedRequest, prepared: PreparedContinuityRequest,
  selection: CompactionSelection, logicalWorkId: string, summary: string, preserveFinalResponse: boolean): RecoveryCheckpointRecord {
  assertHealthyRecoveryCompactionAuthority(prepared);
  const acceptedPlan = preparedPlans.get(prepared);
  if (prepared.recovery && acceptedPlan?.acceptedHandoffIdentity
    && sameContinuityRecoveryIdentity(prepared.recovery, acceptedPlan.acceptedHandoffIdentity)
    && acceptedPlan.acceptedHandoff === summary) {
    const current = prepared.bindings.recoveryStore.get(prepared.binding.thread)!;
    if (!sameContinuityRecoveryIdentity(prepared.recovery, recoveryIdentity(current, prepared.bindings.recoveryStore.installationId()))) {
      throw continuityError("continuity_source_unproven", "The accepted handoff cannot settle a different compaction attempt.");
    }
  } else if (prepared.recovery) healthyRecoveryRecord(prepared);
  const store = prepared.bindings.recoveryStore;
  let record = store.get(prepared.binding.thread)!;
  const work = record.works[logicalWorkId];
  if (!work || work.state === "stopped") throw continuityError("continuity_stopped");
  if (record.currentWorkId !== logicalWorkId || record.epoch !== work.attempts.at(-1)!.epoch) {
    throw continuityError("continuity_source_unproven", "A late summary cannot commit to a newer attempt.");
  }
  const attempt = work.attempts.at(-1)!;
  record = store.retireAttempt(record.thread, { scope: record.scope, expectedVersion: record.version }, logicalWorkId, attempt.attempt);
  record = registerTarget(store, prepared.bindings.registrations.directory, record, {
    sourceLogicalWorkId: selection.target.sourceLogicalWorkId, sourceIdentity: selection.target.sourceIdentity,
    acceptedTaskRevision: selection.target.acceptedTaskRevision, sourceHistoryRevision: selection.target.sourceHistoryRevision,
    sourceToolBatchHeadSequence: selection.target.sourceToolBatchHeadSequence, representationDigests: representations(parsed, selection, summary),
  });
  const coverage = Object.values(record.calls).filter(call => call.workLineageId === selection.target.workLineageId
    && call.state === "settled" && call.batchSequence <= selection.target.sourceToolBatchHeadSequence).map(call => call.callId);
  const source = record.works[selection.source.logicalWorkId]!;
  const retainedBodyBytes = Math.max(prepared.binding.acceptedHandoff?.bytes ?? 0,
    Buffer.byteLength(summary) + Buffer.byteLength(JSON.stringify({
      sourceInstruction: selection.sourceRevision, sourceRepresentationDigests: representations(parsed, selection, summary),
    })));
  const commitId = continuityDigest([selection.target.compactionTargetId, "checkpoint"]);
  record = store.commitCheckpoint(record.thread, { scope: record.scope, expectedVersion: record.version }, {
    logicalWorkId, commitId, compactionTargetId: selection.target.compactionTargetId, summaryDigest: continuityDigest(summary),
    coveredCallIds: coverage, retainedBodyBytes,
    ...(preserveFinalResponse && source.terminalReceiptId ? { ordinaryFinalReceiptId: source.terminalReceiptId } : {}),
    nativeTurnId: extractChatGptTurnIdentity(parsed).turnId,
  });
  return record.checkpoints[commitId]!;
}

export function beginHealthyRecoveryCompaction(parsed: CodexParsedRequest, prepared: PreparedContinuityRequest,
  timeoutMs = MAX_COMPACTION_HANDOFF_TIMEOUT_MS): string | undefined {
  const selection = requestTargets.get(parsed);
  if (!selection) return undefined;
  const logicalWorkId = `compaction:${selection.target.compactionTargetId}`;
  const store = prepared.bindings.recoveryStore;
  const record = store.get(prepared.binding.thread)!;
  const launcherInstance = readLauncherContinuityInstance(prepared.descriptor);
  const sourceInstance = record.works[selection.source.logicalWorkId]!.attempts.at(-1)!.launcherInstance;
  if (!sourceInstance || !sameContinuityLauncherInstance(sourceInstance, launcherInstance)) {
    throw continuityError("continuity_unverified", "The retained source belongs to a different Launcher instance.");
  }
  const admitted = store.admitWork({ thread: record.thread, scope: record.scope, owner: continuityProcessInstance(prepared.bindings.owner),
    logicalWorkId, instructionIdentity: logicalWorkId, nativeTurnId: extractChatGptTurnIdentity(parsed).turnId,
    workPayloadDigest: compactionPayloadDigest(parsed, selection.target), snapshotDigest: continuityDigest({ control: compactPrompt(parsed) }),
    purpose: "compaction", compactionTargetId: selection.target.compactionTargetId, createPage: false, activate: false,
    dispatchProtocolComplete: true });
  let controlled = store.markAttempt(admitted.thread, { scope: admitted.scope, expectedVersion: admitted.version }, {
    logicalWorkId, attempt: admitted.works[logicalWorkId]!.attempts.at(-1)!.attempt,
    stage: isChatGptWebZeroRiskBackendModel(parsed.modelId) ? "send-possible" : "prepared", launcherInstance: sourceInstance });
  const budget = controlled.works[logicalWorkId]!.retryBudget!;
  controlled = store.setCompactionDeadline(controlled.thread, { scope: controlled.scope, expectedVersion: controlled.version },
    logicalWorkId, budget.deadlineAt ?? budget.startedAt + Math.min(timeoutMs, MAX_COMPACTION_HANDOFF_TIMEOUT_MS));
  retainHealthyObserver(prepared, controlled.works[logicalWorkId]!);
  return logicalWorkId;
}

export function admitHealthyRecoveryCompaction(parsed: CodexParsedRequest, prepared: PreparedContinuityRequest,
  ordinaryFinalAnswer?: string): string | undefined {
  const selection = requestTargets.get(parsed);
  if (!selection) return undefined;
  assertHealthyRecoveryCompactionAuthority(prepared);
  const store = prepared.bindings.recoveryStore;
  let record = store.get(prepared.binding.thread)!;
  let source = record.works[selection.source.logicalWorkId]!;
  if (ordinaryFinalAnswer !== undefined && source.state !== "completed") {
    if (record.currentWorkId !== source.logicalWorkId || source.attempts.at(-1)!.epoch !== record.epoch) {
      throw continuityError("continuity_source_unproven", "The ordinary final belongs to an obsolete compaction source.");
    }
    record = store.completeWork(record.thread, { scope: record.scope, expectedVersion: record.version }, source.logicalWorkId,
      { receiptId: recoveryDigest([source.logicalWorkId, "final"]), digest: recoveryDigest(ordinaryFinalAnswer) });
    source = record.works[source.logicalWorkId]!;
  }
  if (ordinaryFinalAnswer !== undefined && prepared.sourceExecutionKey) {
    chatGptTurnSessions.find(prepared.sourceExecutionKey)?.retainRecoveryFinalReceipt(
      recoveryFinalReceipt(prepared.bindings.registrations.directory, record, source.logicalWorkId));
  }
  if (!source.attempts.at(-1)!.writerRetired) {
    record = store.retireAttempt(record.thread, { scope: record.scope, expectedVersion: record.version },
      source.logicalWorkId, source.attempts.at(-1)!.attempt);
  }
  const logicalWorkId = `compaction:${selection.target.compactionTargetId}`;
  const work = record.works[logicalWorkId];
  if (!work) throw continuityError("continuity_source_unproven", "The healthy control did not reserve its durable attempt.");
  const attempt = work.attempts.at(-1)!;
  if (work.activationState === "shadow") {
    record = store.activateCompaction(record.thread, { scope: record.scope, expectedVersion: record.version }, logicalWorkId, {
      attempt: attempt.attempt, snapshotVersion: attempt.snapshotVersion,
      transactionId: attempt.transactionId!, transactionVersion: attempt.transactionVersion!,
    });
  } else if (record.currentWorkId !== logicalWorkId) throw continuityError("continuity_source_unproven");
  prepared.recovery = recoveryIdentity(record, store.installationId());
  retainHealthyObserver(prepared, record.works[logicalWorkId]!);
  prepared.binding.recovery = { directory: prepared.bindings.registrations.directory, thread: record.thread,
    logicalWorkId, attempt: attempt.attempt, ownerId: record.owner.id };
  return logicalWorkId;
}

export async function prepareHealthyRecoveryCompactionControl(prepared: PreparedContinuityRequest, instruction: string): Promise<ContinuityClaim> {
  assertHealthyRecoveryCompactionAuthority(prepared);
  const store = prepared.bindings.recoveryStore;
  let record = store.get(prepared.binding.thread)!;
  const workId = prepared.recovery?.logicalWorkId;
  if (!workId || record.currentWorkId !== workId) throw continuityError("continuity_source_unproven");
  const launcherInstance = readLauncherContinuityInstance(prepared.descriptor);
  const sourceInstance = record.works[workId]!.attempts.at(-1)!.launcherInstance;
  if (!sourceInstance || !sameContinuityLauncherInstance(sourceInstance, launcherInstance)) {
    throw continuityError("continuity_unverified", "The healthy handoff cannot move to another Launcher instance.");
  }
  record = store.rebindSnapshot(record.thread, { scope: record.scope, expectedVersion: record.version }, workId,
    continuityDigest({ text: instruction, images: [] }));
  record = store.markAttempt(record.thread, { scope: record.scope, expectedVersion: record.version }, {
    logicalWorkId: workId, attempt: record.works[workId]!.attempts.at(-1)!.attempt, stage: "page-possible", launcherInstance });
  prepared.recovery = recoveryIdentity(record, store.installationId());
  retainHealthyObserver(prepared, record.works[workId]!);
  return { owner: prepared.bindings.owner, expected: prepared.binding.lease, recovery: prepared.recovery };
}

function healthyRecoveryRecord(prepared: PreparedContinuityRequest): RecoveryThreadRecord {
  const identity = prepared.recovery;
  if (!identity) throw continuityError("continuity_source_unproven");
  const record = checkAttempt(prepared, identity.logicalWorkId, identity.attempt, identity.epoch, identity.snapshotVersion);
  if (record.transaction?.transactionId !== identity.transactionId || record.transaction.version !== identity.transactionVersion) {
    throw continuityError("continuity_source_unproven");
  }
  return record;
}
export function acceptHealthyRecoveryCompactionLease(prepared: PreparedContinuityRequest, lease: ContinuityLease): void {
  const record = healthyRecoveryRecord(prepared);
  if (!lease.recovery || continuityDigest(lease.recovery) !== continuityDigest(prepared.recovery)) throw continuityError("continuity_source_unproven");
  prepared.bindings.recoveryStore.markAttempt(record.thread, { scope: record.scope, expectedVersion: record.version }, {
    logicalWorkId: prepared.recovery!.logicalWorkId, attempt: prepared.recovery!.attempt, stage: "page-acquired", pageReceiptId: lease.leaseId });
}
export async function markHealthyRecoveryCompactionSend(prepared: PreparedContinuityRequest): Promise<void> {
  const record = healthyRecoveryRecord(prepared);
  healthySends.set(prepared, beginRecoverySend({ directory: prepared.bindings.registrations.directory,
    thread: record.thread, logicalWorkId: prepared.recovery!.logicalWorkId, attempt: prepared.recovery!.attempt,
    ownerId: record.owner.id }, prepared.recovery!));
  await markLauncherContinuitySendPossible(prepared.descriptor, prepared.recovery!, prepared.bindings.registrations.directory);
  healthyRecoveryRecord(prepared);
}
export function markHealthyRecoveryCompactionAccepted(prepared: PreparedContinuityRequest): boolean {
  const reference = healthySends.get(prepared);
  if (reference && !settleRecoverySend(reference).currentWriter) return false;
  const record = healthyRecoveryRecord(prepared);
  if (!reference) prepared.bindings.recoveryStore.markAttempt(record.thread, { scope: record.scope, expectedVersion: record.version }, {
      logicalWorkId: prepared.recovery!.logicalWorkId, attempt: prepared.recovery!.attempt, stage: "accepted" });
  return true;
}
export async function failHealthyRecoveryCompaction(parsed: CodexParsedRequest, prepared: PreparedContinuityRequest): Promise<void> {
  const selection = requestTargets.get(parsed);
  if (!selection) return;
  try { assertHealthyRecoveryCompactionAuthority(prepared); }
  catch { return; }
  const workId = `compaction:${selection.target.compactionTargetId}`;
  const store = prepared.bindings.recoveryStore;
  let record = store.get(prepared.binding.thread)!;
  const work = record.works[workId];
  if (!work || ["completed", "stopped"].includes(work.state)) return;
  const attempt = work.attempts.at(-1)!;
  if (prepared.recovery && (prepared.recovery.logicalWorkId !== workId || prepared.recovery.attempt !== attempt.attempt
    || prepared.recovery.epoch !== attempt.epoch || prepared.recovery.snapshotVersion !== attempt.snapshotVersion)) return;
  let retired = work.activationState === "shadow" || attempt.stage === "prepared";
  if (!retired && prepared.recovery) {
    try { retired = (await retireLauncherContinuityWriter(prepared.descriptor, prepared.recovery, prepared.bindings.registrations.directory)).writerRetired; }
    catch { /* An unknown physical summary writer remains unknown. */ }
  }
  record = store.get(record.thread)!;
  if (retired) record = store.retireAttempt(record.thread, { scope: record.scope, expectedVersion: record.version }, workId, attempt.attempt);
  store.recordFailure(record.thread, { scope: record.scope, expectedVersion: record.version }, workId);
}

function checkAttempt(prepared: PreparedContinuityRequest, workId: string, attemptNumber: number, epoch: number,
  snapshotVersion: number): RecoveryThreadRecord {
  const record = prepared.bindings.recoveryStore.get(prepared.binding.thread)!;
  const work = record.works[workId];
  const attempt = work?.attempts.at(-1);
  if (work?.state === "stopped") throw continuityError("continuity_stopped");
  if (record.currentWorkId !== workId || record.epoch !== epoch || !attempt || attempt.attempt !== attemptNumber
    || attempt.snapshotVersion !== snapshotVersion || attempt.writerRetired) {
    throw continuityError("continuity_source_unproven", "The compaction observer belongs to an obsolete recovery attempt.");
  }
  return record;
}

export async function runRecoveryCompaction(parsed: CodexParsedRequest, prepared: PreparedContinuityRequest,
  worker: ChatGptBrowserWorker, owner: TurnBrokerOwner, capabilities: ChatGptWebCapabilities, namespace: string,
  configuredTimeout?: number, onProgress?: () => void, onRecovered?: () => void,
  startManual?: StartManualRecoveryCompaction): Promise<string> {
  const plan = preparedPlans.get(prepared);
  if (!plan) throw continuityError("continuity_source_unproven");
  if (plan.mode === "observe") {
    // Keep the actual promise: cache eviction must never turn this observer into a writer.
    assertRecoveryCompactionNotStopped(parsed, prepared);
    const result = await plan.observedRun!.catch(error => failRecoveryCompactionObserver(parsed, prepared, plan, error));
    assertRecoveryCompactionNotStopped(parsed, prepared);
    await assertRecoveryCompactionResult(prepared);
    const record = prepared.bindings.recoveryStore.get(prepared.binding.thread)!;
    const checkpoint = Object.values(record.checkpoints).find(value => value.compactionTargetId === plan.target.compactionTargetId)!;
    if (continuityDigest(result) !== checkpoint.summaryDigest) throw continuityError("continuity_replay_unavailable");
    return result;
  }
  if (plan.mode === "replay") {
    await assertRecoveryCompactionResult(prepared);
    let result = plan.summary;
    if (!result) {
      try { result = await plan.observedRun; }
      catch { throw continuityError("continuity_replay_unavailable", "The committed compaction has no successful cached result body."); }
    }
    if (!result || continuityDigest(result) !== plan.checkpoint!.summaryDigest) {
      throw continuityError("continuity_replay_unavailable", "The committed compaction has no matching result body.");
    }
    const record = prepared.bindings.recoveryStore.get(prepared.binding.thread)!;
    if (![...prepared.binding.checkpoints.values()].some(checkpoint => checkpoint.sourceRevision === plan.checkpoint!.sourceHistoryRevision
      && checkpoint.revision === plan.checkpoint!.targetHistoryRevision && continuityDigest(checkpoint.summary) === plan.checkpoint!.summaryDigest)
      && record.currentWorkId === `compaction:${plan.target.compactionTargetId}`
      && record.historyRevision === plan.checkpoint!.targetHistoryRevision
      && prepared.binding.epoch === record.epoch) {
      // A durable commit may outlive local publication. Repair only its still-current head.
      prepared.bindings.installRecoveryCheckpoint(prepared.binding, prepared.executionKey, plan.checkpoint!, result,
          plan.sourceRevision, plan.checkpoint!.representationDigests, plan.preserveFinalResponse, plan.sourceExecutionKey);
    }
    return result;
  }
  if (!(owner instanceof TurnBroker)) throw continuityError("continuity_configuration_conflict");
  const identity = extractChatGptTurnIdentity(parsed);
  const traceId = createHash("sha256").update(`${prepared.executionKey}:recovery-handoff`).digest("hex").slice(0, 12);
  const running = runStructuredCompactionOnce(prepared.executionKey, {
    ownerKey: `${namespace}:continuity-recovery:${prepared.binding.thread}:${prepared.binding.pageGeneration ?? parsed._continuityPageGeneration}`, traceIds: [traceId],
    page: { directory: prepared.bindings.registrations.directory, thread: prepared.binding.thread,
      epoch: prepared.binding.pageGeneration ?? parsed._continuityPageGeneration! },
    nativeThreadId: identity.threadId, nativeTurnId: identity.turnId,
    requestDigest: compactionPayloadDigest(parsed, plan.target),
  }, async (operatorSignal, retainOwnershipUntil) => {
    const timeoutMs = Math.min(configuredTimeout ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
    const deadline = new AbortController();
    let timer = setTimeout(() => deadline.abort(continuityError("continuity_session_lost", "The recovered compaction exceeded its bounded deadline.")), timeoutMs);
    timer.unref?.();
    const signal = AbortSignal.any([operatorSignal, deadline.signal]);
    const browserAbort = new AbortController();
    let manualRuntime: ChatGptTurnRuntime | undefined;
    const abortBrowser = (): void => {
      browserAbort.abort(signal.reason);
      manualRuntime?.cancel(signal.reason instanceof Error ? signal.reason : undefined);
    };
    signal.addEventListener("abort", abortBrowser, { once: true });
    const store = prepared.bindings.recoveryStore;
    let transaction: Awaited<ReturnType<TurnBroker["beginCompactionTransaction"]>> | undefined;
    let sourceToken: string | undefined;
    let browser: Promise<string> | undefined;
    let logicalWorkId: string | undefined;
    let attemptNumber: number | undefined;
    let cleanupIdentity: ReturnType<typeof recoveryIdentity> | undefined;
    let sendReference: RuntimeRecoverySendReference | undefined;
    try {
      signal.throwIfAborted();
      const oldRecord = store.get(prepared.binding.thread)!;
      logicalWorkId = `compaction:${plan.target.compactionTargetId}`;
      if (plan.acceptedHandoff) {
        // This summary was accepted under the original capability. Complete that
        // attempt before considering a successor; never rebind its credentials.
        prepared.recovery = plan.acceptedHandoffIdentity;
        prepared.binding = prepared.bindings.installRecovered(oldRecord, prepared.executionKey,
          continuityCheckpoint(parsed).digest, identity.turnId);
        prepared.binding.conversation = { key: prepared.conversationKey, descriptor: prepared.descriptor };
        const checkpoint = commitRecoveryCompaction(parsed, prepared, plan, logicalWorkId,
          plan.acceptedHandoff, plan.preserveFinalResponse);
        prepared.bindings.installRecoveryCheckpoint(prepared.binding, prepared.executionKey, checkpoint, plan.acceptedHandoff,
          plan.sourceRevision, checkpoint.representationDigests, plan.preserveFinalResponse, plan.sourceExecutionKey);
        return plan.acceptedHandoff;
      }
      const priorBudget = oldRecord.works[logicalWorkId]?.retryBudget;
      if (priorBudget?.deadlineAt !== undefined && Date.now() >= priorBudget.deadlineAt) {
        throw continuityError("continuity_retry_exhausted", "The original compaction deadline has expired.");
      }
      // Physical capacity waiting does not allocate or fail a business attempt.
      await assertLauncherContinuityCapacity(prepared.descriptor);
      signal.throwIfAborted();
      if (store.get(oldRecord.thread)?.version !== oldRecord.version) throw continuityError("continuity_source_unproven");
      let compiled: CompiledChatGptWebPrompt | undefined;
      signal.throwIfAborted();
      const snapshotDigest = continuityDigest({ control: compactPrompt(parsed), sources: plan.sourceSnapshot!.targets.map(target => ({
        kind: target.kind, role: target.original_role, callId: target.call_id, digest: target.content_digest,
      })) });
      const existing = oldRecord.works[logicalWorkId];
      if (existing?.attempts.at(-1)?.acquisitionEvidence?.status === "not-acquired"
        && existing.attempts.at(-1)!.snapshotDigest !== snapshotDigest) throw continuityError("continuity_source_unproven");
      let record: RecoveryThreadRecord;
      if (existing && existing.state !== "completed" && existing.attempts.at(-1)!.writerRetired) {
        record = store.reserveRecovery(oldRecord.thread, { scope: oldRecord.scope, expectedVersion: oldRecord.version }, {
          logicalWorkId, owner: continuityProcessInstance(prepared.bindings.owner), snapshotDigest });
      } else {
        record = store.admitWork({ thread: oldRecord.thread, scope: oldRecord.scope, owner: continuityProcessInstance(prepared.bindings.owner),
          logicalWorkId, instructionIdentity: logicalWorkId, nativeTurnId: identity.turnId,
          workPayloadDigest: compactionPayloadDigest(parsed, plan.target), snapshotDigest,
          purpose: "compaction", compactionTargetId: plan.target.compactionTargetId, createPage: true, dispatchProtocolComplete: true });
      }
      const attempt = record.works[logicalWorkId]!.attempts.at(-1)!;
      attemptNumber = attempt.attempt;
      const budget = record.works[logicalWorkId]!.retryBudget!;
      const deadlineAt = budget.deadlineAt ?? budget.startedAt + timeoutMs;
      record = store.setCompactionDeadline(record.thread, { scope: record.scope, expectedVersion: record.version }, logicalWorkId, deadlineAt);
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw continuityError("continuity_retry_exhausted", "The original compaction deadline has expired.");
      clearTimeout(timer);
      timer = setTimeout(() => deadline.abort(continuityError("continuity_session_lost", "The recovered compaction exceeded its original deadline.")), remainingMs);
      timer.unref?.();
      cleanupIdentity = recoveryIdentity(record, store.installationId());
      prepared.recovery = cleanupIdentity;
      parsed._continuityEpoch = record.epoch;
      prepared.conversationKey = chatGptConversationKey(parsed, namespace)!;
      prepared.binding = prepared.bindings.installRecovered(record, prepared.executionKey, continuityCheckpoint(parsed).digest, identity.turnId);
      prepared.binding.conversation = { key: prepared.conversationKey, descriptor: prepared.descriptor };
      const check = (): RecoveryThreadRecord => checkAttempt(prepared, logicalWorkId!, attempt.attempt, attempt.epoch, attempt.snapshotVersion);
      let summary: string;
      if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
        if (!startManual || !plan.preserveFinalResponse && !freshPageCompactions.has(parsed)) throw continuityError("continuity_manual_handoff_required");
        // The manual runtime owns a new start/Sent token and this durable attempt.
        // It never refreshes the completed ordinary source's Send authorization.
        prepared.input = plan.input;
        manualRuntime = startManual({ traceId, sourceSnapshot: plan.sourceSnapshot!, deadlineAt, signal,
          verifyCompleteSource(snapshot) {
            const current = check();
            if (snapshot !== plan.sourceSnapshot) throw continuityError("continuity_source_unproven");
            const coverage = (current.contextCoverage ?? []).filter(entry => entry.workLineageId === plan.target.workLineageId);
            const covered = Object.values(current.checkpoints).some(checkpoint => checkpoint.summaryDigest === continuityCheckpoint(parsed).digest
              && checkpoint.targetHistoryRevision === plan.target.sourceHistoryRevision
              && checkpoint.workLineageId === plan.target.workLineageId
              && checkpoint.acceptedTaskRevision === plan.target.acceptedTaskRevision
              && checkpoint.sourceToolBatchHeadSequence === plan.target.sourceToolBatchHeadSequence);
            if (!freshPageCompactions.has(parsed) && (coverage.length || !covered)) CompactionSourceCoverage.assertRecordedSource(snapshot,
              coverage.map(entry => entry.metadata), plan.target.sourceHistoryRevision);
          } });
        browser = manualRuntime.browser;
        if (manualRuntime.mode === "tools") void manualRuntime.token.catch(() => {});
        retainOwnershipUntil(manualRuntime.physicalSettlement);
        summary = canonicalizeCompactionHandoff(parsed, await withCompactionAbort(browser, signal));
        check();
        prepared.binding.acceptedHandoff = { key: prepared.executionKey,
          sourceExecutionKey: plan.sourceExecutionKey ?? prepared.executionKey, sourceRevision: plan.target.sourceHistoryRevision,
          bytes: Buffer.byteLength(summary), summary, lease: { ...prepared.binding.lease! } };
        await withCompactionAbort(manualRuntime.physicalSettlement, signal);
        await manualRuntime.retireCapability?.();
        const lease = prepared.binding.lease;
        if (!lease || (await inspectLauncherContinuityConversation(prepared.descriptor, prepared.conversationKey, lease)).state !== "ready") {
          throw continuityError("continuity_session_lost");
        }
      } else {
        const pendingTransaction = owner.beginCompactionTransaction(traceId, remainingMs);
        void pendingTransaction.then(lateTransaction => {
          if (signal.aborted && transaction !== lateTransaction) owner.abortCompactionTransaction(lateTransaction.token);
        }, () => {});
        transaction = await withCompactionAbort(pendingTransaction, signal);
        check();
        const registered = await registerCompactionSource(owner, {
          snapshot: plan.sourceSnapshot!, contract: "native", transactionToken: transaction.token,
          handoffId: transaction.handoffId, historyRevision: plan.target.sourceHistoryRevision,
          recovery: { directory: prepared.bindings.registrations.directory, thread: record.thread,
            logicalWorkId, attempt: attempt.attempt, ownerId: record.owner.id },
          ownerGeneration: `${prepared.bindings.owner}:${attempt.epoch}:${attempt.attempt}`,
          expiresAt: deadlineAt,
          availableTokens: compactionAvailableTokens(parsed, capabilities, 0),
        }, structuredCompactionHandoffInstruction(transaction, compactPrompt(parsed)));
        sourceToken = registered.token;
        compiled = { text: registered.instruction, images: [] };
        assertContinuityCompiledInput(compiled, { ...plan.input!, context: { ...plan.input!.context, messages: [] } }, capabilities);
        let reportedRecovery = false;
        summary = plan.acceptedHandoff!;
        if (!summary) {
          signal.throwIfAborted();
          record = check();
          record = store.markAttempt(record.thread, { scope: record.scope, expectedVersion: record.version }, {
            logicalWorkId, attempt: attempt.attempt, stage: "page-possible",
            launcherInstance: readLauncherContinuityInstance(prepared.descriptor) });
          const recovery = recoveryIdentity(record, store.installationId());
          const recoveryReference = { directory: prepared.bindings.registrations.directory, thread: record.thread,
            logicalWorkId, attempt: attempt.attempt, ownerId: record.owner.id };
          const acquisitionRequestId = randomBytes(24).toString("hex");
          beginRecoveryAcquisition(recoveryReference, recovery, acquisitionRequestId);
          cleanupIdentity = recovery;
          prepared.recovery = recovery;
          const prepare = async () => {
            signal.throwIfAborted(); check();
            return { ...compiled!, release() {} };
          };
          browser = worker.run({ traceId, modelId: parsed.modelId, reasoning: parsed.options.reasoning,
            ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
            capabilities: { ...capabilities, localToolsEnabled: false }, nativeConnector: true,
            continuity: { owner: prepared.bindings.owner, recovery }, recoveryStoreDirectory: prepared.bindings.registrations.directory,
            recoveryRequestId: acquisitionRequestId,
            conversationKey: prepared.conversationKey,
            retainConversation: true, compaction: true, prepare, prepareResume: prepare,
            onContinuityLease(lease) {
              const current = check();
              if (lease.traceId !== traceId || !lease.recovery || !sameContinuityRecoveryIdentity(lease.recovery, recovery)) {
                throw continuityError("continuity_source_unproven");
              }
              store.markAttempt(current.thread, { scope: current.scope, expectedVersion: current.version }, {
                logicalWorkId: logicalWorkId!, attempt: attempt.attempt, stage: "page-acquired", pageReceiptId: lease.leaseId });
              prepared.bindings.acceptLease(prepared.binding, lease);
              prepared.releaseAdmission?.();
            },
            async onSendActivated() {
              check();
              sendReference = beginRecoverySend(recoveryReference, recovery, acquisitionRequestId);
              await markLauncherContinuitySendPossible(prepared.descriptor, recovery, prepared.bindings.registrations.directory);
              check();
              if (!reportedRecovery) {
                reportedRecovery = true;
                try { onRecovered?.(); } catch { /* An observer can detach without stopping this transaction. */ }
              }
            },
            onSubmitted() {
              if (!sendReference) throw continuityError("continuity_source_unproven");
              if (!settleRecoverySend(sendReference).currentWriter) return;
              check();
              owner.markCompactionContextDelivered(sourceToken!);
            }, abortSignal: browserAbort.signal, onTextDelta() { onProgress?.(); },
          });
          retainOwnershipUntil(browser.then(() => undefined, () => undefined));
          const noHandoff = browser.then<never>(() => { throw continuityError("continuity_source_unproven", "The new page settled without a structured handoff."); });
          summary = canonicalizeCompactionHandoff(parsed, await withCompactionAbort(Promise.race([
            owner.waitForCompactionHandoff(transaction!.token, signal), noHandoff,
          ]), signal));
          check();
          // Retain the valid body before physical cleanup. A failed cleanup must not generate it twice.
          prepared.binding.acceptedHandoff = { key: prepared.executionKey,
            sourceExecutionKey: plan.sourceExecutionKey ?? prepared.executionKey, sourceRevision: plan.target.sourceHistoryRevision,
            bytes: Buffer.byteLength(summary), summary, lease: { ...prepared.binding.lease! } };
          browserAbort.abort(new ChatGptCompactionHandoffAccepted());
          await withCompactionAbort(browser.then(() => undefined, () => undefined), signal);
          const lease = prepared.binding.lease;
          if (!lease) throw continuityError("continuity_session_lost");
          const page = await inspectLauncherContinuityConversation(prepared.descriptor, prepared.conversationKey, lease);
          if (page.state !== "ready") throw continuityError("continuity_session_lost");
        }
      }
      signal.throwIfAborted(); check();
      const checkpoint = commitRecoveryCompaction(parsed, prepared, plan, logicalWorkId, summary, plan.preserveFinalResponse);
      prepared.bindings.installRecoveryCheckpoint(prepared.binding, prepared.executionKey, checkpoint, summary,
        plan.sourceRevision, checkpoint.representationDigests, plan.preserveFinalResponse, plan.sourceExecutionKey);
      const pageCost = await compactionSourcePageCost(owner, plan.sourceSnapshot!);
      prepared.binding.retainedPageTokens = pageCost === undefined ? undefined : pageCost + estimateTokens(summary);
      onProgress?.();
      return summary;
    } catch (error) {
      browserAbort.abort(error);
      manualRuntime?.cancel(error instanceof Error ? error : undefined);
      // Physical cleanup remains in the owner gate. A deadline cannot wait forever for it.
      const physical = browser?.then(() => undefined, () => undefined);
      if (physical) retainOwnershipUntil(physical);
      if (transaction) owner.abortCompactionTransaction(transaction.token);
      if (cleanupIdentity && prepared.binding.lease) {
        let alive = false;
        try {
          const page = await inspectLauncherContinuityConversation(prepared.descriptor, prepared.conversationKey, prepared.binding.lease);
          alive = page.state === "ready" || page.state === "running";
        } catch { /* Closed and unknown pages revoke this exact generation. */ }
        if (!alive) {
          try { prepared.bindings.forgetPage(prepared.binding, prepared.executionKey,
            { ownerId: prepared.bindings.owner, identity: cleanupIdentity }); }
          catch { /* A successor already owns the thread. */ }
          throw error;
        }
      }
      if (logicalWorkId && attemptNumber !== undefined) {
        const ref = { directory: prepared.bindings.registrations.directory, thread: prepared.binding.thread,
          logicalWorkId, attempt: attemptNumber };
        if (settleRecoveryKnownUnsent(ref, error)) throw error;
        let record = store.get(prepared.binding.thread);
        const work = record?.works[logicalWorkId];
        if (record && work && work.state !== "completed" && work.state !== "stopped"
          && record.currentWorkId === logicalWorkId && cleanupIdentity
          && record.epoch === cleanupIdentity.epoch && work.attempts.at(-1)?.attempt === attemptNumber
          && work.attempts.at(-1)!.snapshotVersion === cleanupIdentity.snapshotVersion
          && record.transaction?.transactionId === cleanupIdentity.transactionId
          && record.transaction.version === cleanupIdentity.transactionVersion) {
          const stage = work.attempts.at(-1)!.stage;
          let retired = stage === "prepared";
          if (!retired && cleanupIdentity) {
            try { retired = (await retireLauncherContinuityWriter(prepared.descriptor, cleanupIdentity, prepared.bindings.registrations.directory)).writerRetired; }
            catch { /* Unknown writer ownership must remain unknown in the journal. */ }
          }
          if (retired) {
            record = store.get(record.thread)!;
            store.retireAttempt(record.thread, { scope: record.scope, expectedVersion: record.version }, logicalWorkId, attemptNumber);
          }
          store.recordFailure(record.thread, { scope: record.scope }, logicalWorkId);
          record = store.get(record.thread)!;
          if (record.currentWorkId === logicalWorkId && record.epoch === prepared.binding.epoch
            && record.works[logicalWorkId]!.attempts.at(-1)!.attempt === attemptNumber) {
            prepared.bindings.lose(prepared.binding, prepared.executionKey);
          }
        }
      }
      throw error;
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abortBrowser);
      if (sourceToken) owner.revokeCompactionContext(sourceToken);
      if (transaction) owner.abortCompactionTransaction(transaction.token);
    }
  });
  return running.catch(error => failRecoveryCompactionObserver(parsed, prepared, plan, error));
}

function failRecoveryCompactionObserver(parsed: CodexParsedRequest, prepared: PreparedContinuityRequest,
  plan: RecoveryCompactionPlan, error: unknown): never {
  assertRecoveryCompactionNotStopped(parsed, prepared);
  if (["client_cancelled", "continuity_stopped"].includes(String((error as { code?: string })?.code))) {
    const record = prepared.bindings.recoveryStore.get(prepared.binding.thread);
    if (record?.works[plan.source.logicalWorkId]) {
      prepared.bindings.recoveryStore.stopWork(record.thread, { scope: record.scope }, plan.source.logicalWorkId, "native-interrupt");
    }
  }
  if (error instanceof ChatGptWebAdapterError) throw error;
  throw continuityError("continuity_source_unproven", "The handoff did not commit; already accepted results were not re-executed.");
}
