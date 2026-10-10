import { createHash } from "node:crypto";
import type { CodexParsedRequest, CodexProviderConfig } from "../../types";
import { buildCompactV1Output, COMPACT_PROMPT, extractCompactUserMessages } from "../../responses/compaction";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { assertLauncherContinuityCapacity, inspectLauncherContinuityConversation,
  markLauncherContinuitySendPossible, readLauncherContinuityInstance, retireLauncherContinuityWriter } from "../../launcher-browser-host";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptBrowserWorker } from "./browser-worker";
import { canonicalizeCompactionHandoff, existingStructuredCompactionRun, MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  runStructuredCompactionOnce, withCompactionAbort } from "./compaction-handoff";
import { continuityCheckpoint, continuityDigest, continuitySourceRepresentationDigest,
  type ContinuityBinding, type ContinuityBindings, type ContinuityClaim } from "./continuity-binding";
import { sameContinuityLauncherInstance, sameContinuityRecoveryIdentity, type ContinuityLease } from "./continuity-contract";
import { chatGptConversationKey } from "./conversation-key";
import { continuityError } from "./continuity-errors";
import { assertContinuityCompiledInput } from "./continuity-input";
import type { PreparedContinuityRequest } from "./continuity-request";
import { evictOptionalRecoveryResults, recoveryCanonicalResults, recoveryContext, recoveryDigest, recoveryFinalReceipt, recoveryIdentity, recoveryResultDigest } from "./continuity-recovery-runtime";
import { continuityProcessInstance, type RecoveryCheckpointRecord, type RecoveryCompactionTarget,
  MAX_CONTINUITY_RECOVERY_ITEM_BYTES, type ContinuityRecoveryStore, type RecoveryThreadRecord, type RecoveryWorkRecord } from "./continuity-recovery-store";
import { chatGptCurrentInstructionIndex, extractChatGptCompactionSourceRevision, extractChatGptCompactV1SourceRevision,
  extractChatGptTurnIdentity, type ChatGptTurnUserRevision } from "./environment";
import type { ChatGptWebCapabilities } from "./model";
import { structuredCompactionHandoffInstruction } from "./native-compaction-control";
import { compileChatGptWebPrompt, type CompiledChatGptWebPrompt } from "./prompt";
import { TurnBroker, type TurnBrokerOwner } from "./turn-broker";
import { assertContinuityToolResultReplayEvidence, chatGptContinuityInstructionPayloadDigest, chatGptTurnSessions } from "./turn-execution";

interface CompactionSelection {
  target: RecoveryCompactionTarget;
  source: RecoveryWorkRecord;
  sourceRevision: ChatGptTurnUserRevision;
  checkpoint?: RecoveryCheckpointRecord;
}
interface RecoveryCompactionPlan extends CompactionSelection {
  mode: "replay" | "recover";
  input?: CodexParsedRequest;
  summary?: string;
  acceptedHandoff?: string;
  sourceExecutionKey?: string;
  sourceBinding?: ContinuityBinding;
  preserveFinalResponse: boolean;
}
const preparedPlans = new WeakMap<PreparedContinuityRequest, RecoveryCompactionPlan>();
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
function registerTarget(store: ContinuityRecoveryStore, directory: string, record: RecoveryThreadRecord,
  input: Parameters<ContinuityRecoveryStore["registerCompactionTarget"]>[2], retainRequiredInput?: () => void): RecoveryThreadRecord {
  try { return store.registerCompactionTarget(record.thread, { scope: record.scope, expectedVersion: record.version }, input); }
  catch (error) {
    if ((error as { code?: string })?.code !== "continuity_resource_capacity") throw error;
    retainRequiredInput?.();
    evictOptionalRecoveryResults(directory);
    const current = store.get(record.thread)!;
    return store.registerCompactionTarget(current.thread, { scope: current.scope, expectedVersion: current.version }, input);
  }
}
function currentCompactionResults(parsed: CodexParsedRequest): Record<string, unknown>[] {
  const input = (parsed._rawBody as { input: unknown[] }).input;
  return recoveryCanonicalResults({ ...parsed, _rawBody: { input: input.slice(chatGptCurrentInstructionIndex(parsed) + 1) } });
}
function sourcePayloadDigest(parsed: CodexParsedRequest, source: RecoveryWorkRecord): string {
  return chatGptContinuityInstructionPayloadDigest(parsed, source.instructionPrevious, source.allowRetainedSourceFallback ?? false);
}
function assertSourcePayload(parsed: CodexParsedRequest, source: RecoveryWorkRecord, target?: RecoveryCompactionTarget): void {
  const payload = sourcePayloadDigest(parsed, source);
  if (payload !== source.workPayloadDigest && !target?.representationDigests.includes(sourcePayloadRepresentation(payload))) {
    throw continuityError("continuity_source_unproven", "The source instruction group conflicts with its first accepted payload.");
  }
}

function sourceIdentity(parsed: CodexParsedRequest, source: ChatGptTurnUserRevision): string {
  const identity = extractChatGptTurnIdentity(parsed);
  return source.itemId ? parsed._chatGptMessageIdAliases?.[source.itemId] ?? source.itemId
    : `turn:${source.turnId ?? identity.turnId}`;
}
function sourceRevisions(parsed: CodexParsedRequest, record: RecoveryThreadRecord): number[] {
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
  assertSourcePayload(parsed, source, target);
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
  if (checkpoint && selectedResults.length) {
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

function selectSource(parsed: CodexParsedRequest, record: RecoveryThreadRecord): RecoveryWorkRecord {
  const source = extractChatGptCompactionSourceRevision(parsed);
  const identity = sourceIdentity(parsed, source);
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

/** Compile the entire canonical input. Ordinary compaction's history trimming is not recovery. */
export function compileRecoveryCompactionInput(parsed: CodexParsedRequest, capabilities: ChatGptWebCapabilities,
  transaction: { token: string; handoffId: string }): CompiledChatGptWebPrompt {
  const input: CodexParsedRequest = { ...parsed, _compactionRequest: false,
    options: { ...parsed.options, outputFormat: undefined }, context: { ...parsed.context, tools: [] } };
  const compiled = compileChatGptWebPrompt(input, { ...capabilities, localToolsEnabled: false });
  compiled.text += `\n\n${structuredCompactionHandoffInstruction(transaction, compactPrompt(parsed))}`;
  assertContinuityCompiledInput(compiled, input, capabilities);
  return compiled;
}

/** Called before retained-page checks so completed results and confirmed loss remain recoverable. */
export async function prepareRecoveryCompaction(parsed: CodexParsedRequest, provider: CodexProviderConfig,
  namespace: string, capabilities: ChatGptWebCapabilities, worker: ChatGptBrowserWorker,
  bindings: ContinuityBindings, record: RecoveryThreadRecord | undefined, descriptor: string,
  abortSignal?: AbortSignal, assertExecutionCompatible?: () => Promise<void>): Promise<PreparedContinuityRequest | undefined> {
  if (!parsed._compactionRequest) return undefined;
  if (!record) throw continuityError("continuity_source_unproven", "A standalone compaction cannot activate a continuity thread.");
  if (record.legacyUnproven) throw continuityError("continuity_legacy_unproven");
  if (record.scope !== parsed._continuityScope) throw continuityError("continuity_configuration_conflict");
  abortSignal?.throwIfAborted();
  const store = bindings.recoveryStore;
  record = store.get(record.thread)!;
  let retainedInput: CodexParsedRequest | undefined;
  let selection = selectRecoveryCompactionTarget(parsed, record);
  if (!selection) {
    const source = selectSource(parsed, record);
    assertSourcePayload(parsed, source);
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
    record = registerTarget(store, bindings.registrations.directory, record, {
      sourceLogicalWorkId: source.logicalWorkId, sourceIdentity: sourceIdentity(parsed, sourceRevision),
      acceptedTaskRevision: source.acceptedTaskRevision, sourceHistoryRevision: revisions[0],
      sourceToolBatchHeadSequence: sequence, representationDigests: [continuitySourceRepresentationDigest(parsed, sourceRevision),
        sourcePayloadRepresentation(source.workPayloadDigest)],
      checkpointBytes: MAX_CONTINUITY_RECOVERY_ITEM_BYTES,
    }, () => {
      const checkpointDigest = continuityCheckpoint(parsed).digest;
      const covered = Object.values(record!.checkpoints).find(value => value.summaryDigest === checkpointDigest
        && value.targetHistoryRevision === revisions[0] && value.workLineageId === source.workLineageId);
      retainedInput = recoveryContext(parsed, { directory: bindings.registrations.directory,
        thread: record!.thread, logicalWorkId: source.logicalWorkId, attempt: source.attempts.at(-1)!.attempt }, covered?.commitId);
    });
    selection = selectRecoveryCompactionTarget(parsed, record);
    if (!selection) throw continuityError("continuity_source_unproven");
  }
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
    preparedPlans.set(prepared, { ...selection, mode: "replay", summary,
      preserveFinalResponse: Boolean(selection.checkpoint.ordinaryFinalReceiptId) });
    return prepared;
  }
  if (selection.source.state === "stopped" || record.works[`compaction:${selection.target.compactionTargetId}`]?.state === "stopped") {
    throw continuityError("continuity_stopped");
  }
  // A network observer attaches to the existing transaction. It never retires that writer.
  if (existingStructuredCompactionRun<string>(executionKey)) {
    const binding = observed ?? bindings.installRecovered(record, executionKey, continuityCheckpoint(parsed).digest, identity.turnId);
    const prepared: PreparedContinuityRequest = { bindings, binding, descriptor, executionKey,
      conversationKey: binding.conversation?.key ?? chatGptConversationKey(parsed, namespace)!, nativeThreadId: identity.threadId,
      revision: selection.target.sourceHistoryRevision };
    preparedPlans.set(prepared, { ...selection, mode: "recover", preserveFinalResponse: selection.source.state === "completed" });
    return prepared;
  }
  const healthy = observed && ["running", "ready", "compacting"].includes(observed.state)
    && ["running", "ready", "compacting"].includes(record.state) && observed.lease && record.owner.id === bindings.owner;
  if (healthy) return undefined;
  await assertExecutionCompatible?.();
  abortSignal?.throwIfAborted();
  const afterCompatibility = store.get(record.thread)!;
  if (afterCompatibility.version !== record.version) {
    return prepareRecoveryCompaction(parsed, provider, namespace, capabilities, worker, bindings, afterCompatibility,
      descriptor, abortSignal, assertExecutionCompatible);
  }
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) throw continuityError("continuity_manual_handoff_required");
  const sourceAttempt = selection.source.attempts.at(-1);
  if (!sourceAttempt) throw continuityError("continuity_source_unproven");
  const accepted = observed?.acceptedHandoff;
  const acceptedHandoff = accepted && accepted.sourceRevision === selection.target.sourceHistoryRevision
    && (accepted.sourceExecutionKey === observed?.executionKey || accepted.key === executionKey)
    ? canonicalizeCompactionHandoff(parsed, accepted.summary) : undefined;
  const checkpointDigest = continuityCheckpoint(parsed).digest;
  const coveredCheckpoint = Object.values(record.checkpoints).find(checkpoint => checkpoint.summaryDigest === checkpointDigest
    && checkpoint.targetHistoryRevision === selection!.target.sourceHistoryRevision
    && checkpoint.workLineageId === selection!.target.workLineageId);
  const input = retainedInput ?? recoveryContext(parsed, { directory: bindings.registrations.directory,
    thread: record.thread, logicalWorkId: selection.source.logicalWorkId, attempt: sourceAttempt.attempt }, coveredCheckpoint?.commitId);
  // Check the complete control envelope before acquiring a new page or admission transaction.
  if (!acceptedHandoff) compileRecoveryCompactionInput(input, capabilities,
    { token: `control_${"0".repeat(32)}`, handoffId: `handoff_${"0".repeat(32)}` });
  record = store.get(record.thread)!;
  // This coordinator verifies the target thread's retired authority, not merely a live PID.
  const { retireRecoveryWriter } = await import("./continuity-recovery-runtime");
  record = await retireRecoveryWriter(bindings, record, descriptor);
  const shadow = record.works[`compaction:${selection.target.compactionTargetId}`];
  if (shadow?.activationState === "shadow") {
    const attempt = shadow.attempts.at(-1)!;
    record = store.activateCompaction(record.thread, { scope: record.scope, expectedVersion: record.version }, shadow.logicalWorkId, {
      attempt: attempt.attempt, snapshotVersion: attempt.snapshotVersion,
      transactionId: attempt.transactionId!, transactionVersion: attempt.transactionVersion!,
    });
  }
  abortSignal?.throwIfAborted();
  const binding = observed ?? bindings.installRecovered(record, executionKey, continuityCheckpoint(parsed).digest, identity.turnId);
  const prepared: PreparedContinuityRequest = { bindings, binding, descriptor, executionKey,
    conversationKey: chatGptConversationKey(parsed, namespace)!, nativeThreadId: identity.threadId,
    revision: selection.target.sourceHistoryRevision, sourceExecutionKey: observed?.executionKey };
  preparedPlans.set(prepared, { ...selection, mode: "recover", input, acceptedHandoff,
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
  ])];
}

/** The durable commit is the success boundary. Page leases never stand in for this receipt. */
export function commitRecoveryCompaction(parsed: CodexParsedRequest, prepared: PreparedContinuityRequest,
  selection: CompactionSelection, logicalWorkId: string, summary: string, preserveFinalResponse: boolean): RecoveryCheckpointRecord {
  assertHealthyRecoveryCompactionAuthority(prepared);
  if (prepared.recovery) healthyRecoveryRecord(prepared);
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

export function beginHealthyRecoveryCompaction(parsed: CodexParsedRequest, prepared: PreparedContinuityRequest): string | undefined {
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
  const controlled = store.markAttempt(admitted.thread, { scope: admitted.scope, expectedVersion: admitted.version }, {
    logicalWorkId, attempt: admitted.works[logicalWorkId]!.attempts.at(-1)!.attempt,
    stage: isChatGptWebZeroRiskBackendModel(parsed.modelId) ? "send-possible" : "prepared", launcherInstance: sourceInstance });
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
  prepared.bindings.recoveryStore.markAttempt(record.thread, { scope: record.scope, expectedVersion: record.version }, {
    logicalWorkId: prepared.recovery!.logicalWorkId, attempt: prepared.recovery!.attempt, stage: "send-possible" });
  await markLauncherContinuitySendPossible(prepared.descriptor, prepared.recovery!);
  healthyRecoveryRecord(prepared);
}
export function markHealthyRecoveryCompactionAccepted(prepared: PreparedContinuityRequest): void {
  const record = healthyRecoveryRecord(prepared);
  prepared.bindings.recoveryStore.markAttempt(record.thread, { scope: record.scope, expectedVersion: record.version }, {
    logicalWorkId: prepared.recovery!.logicalWorkId, attempt: prepared.recovery!.attempt, stage: "accepted" });
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
    try { retired = (await retireLauncherContinuityWriter(prepared.descriptor, prepared.recovery)).writerRetired; }
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
  configuredTimeout?: number, onProgress?: () => void, onRecovered?: () => void): Promise<string> {
  const plan = preparedPlans.get(prepared);
  if (!plan) throw continuityError("continuity_source_unproven");
  if (plan.mode === "replay") {
    await assertRecoveryCompactionResult(prepared);
    let result = plan.summary;
    if (!result) {
      try { result = await existingStructuredCompactionRun<string>(prepared.executionKey); }
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
        plan.sourceRevision, representations(parsed, plan, result), plan.preserveFinalResponse);
    }
    return result;
  }
  if (!(owner instanceof TurnBroker)) throw continuityError("continuity_configuration_conflict");
  const identity = extractChatGptTurnIdentity(parsed);
  const traceId = createHash("sha256").update(`${prepared.executionKey}:recovery-handoff`).digest("hex").slice(0, 12);
  const running = runStructuredCompactionOnce(prepared.executionKey, {
    ownerKey: `${namespace}:continuity-recovery:${prepared.binding.thread}`, traceIds: [traceId],
    nativeThreadId: identity.threadId, nativeTurnId: identity.turnId,
    requestDigest: compactionPayloadDigest(parsed, plan.target),
  }, async (operatorSignal, retainOwnershipUntil) => {
    const timeoutMs = Math.min(configuredTimeout ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(continuityError("continuity_session_lost", "The recovered compaction exceeded its bounded deadline.")), timeoutMs);
    timer.unref?.();
    const signal = AbortSignal.any([operatorSignal, deadline.signal]);
    const browserAbort = new AbortController();
    const abortBrowser = (): void => browserAbort.abort(signal.reason);
    signal.addEventListener("abort", abortBrowser, { once: true });
    const store = prepared.bindings.recoveryStore;
    let transaction: Awaited<ReturnType<TurnBroker["beginCompactionTransaction"]>> | undefined;
    let browser: Promise<string> | undefined;
    let logicalWorkId: string | undefined;
    let attemptNumber: number | undefined;
    let cleanupIdentity: ReturnType<typeof recoveryIdentity> | undefined;
    try {
      signal.throwIfAborted();
      const oldRecord = store.get(prepared.binding.thread)!;
      logicalWorkId = `compaction:${plan.target.compactionTargetId}`;
      let compiled: CompiledChatGptWebPrompt | undefined;
      if (!plan.acceptedHandoff) {
        const pendingTransaction = owner.beginCompactionTransaction(traceId, timeoutMs);
        void pendingTransaction.then(lateTransaction => {
          if (signal.aborted && transaction !== lateTransaction) owner.abortCompactionTransaction(lateTransaction.token);
        }, () => {});
        transaction = await withCompactionAbort(pendingTransaction, signal);
        compiled = compileRecoveryCompactionInput(plan.input!, capabilities, transaction);
      }
      const snapshotDigest = continuityDigest(compiled ?? { summaryDigest: continuityDigest(plan.acceptedHandoff!) });
      const existing = oldRecord.works[logicalWorkId];
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
      cleanupIdentity = recoveryIdentity(record, store.installationId());
      prepared.recovery = cleanupIdentity;
      parsed._continuityEpoch = record.epoch;
      prepared.conversationKey = chatGptConversationKey(parsed, namespace)!;
      prepared.binding = prepared.bindings.installRecovered(record, prepared.executionKey, continuityCheckpoint(parsed).digest, identity.turnId);
      prepared.binding.conversation = { key: prepared.conversationKey, descriptor: prepared.descriptor };
      const check = (): RecoveryThreadRecord => checkAttempt(prepared, logicalWorkId!, attempt.attempt, attempt.epoch, attempt.snapshotVersion);
      let reportedRecovery = false;
      let summary = plan.acceptedHandoff;
      if (!summary) {
        await assertLauncherContinuityCapacity(prepared.descriptor);
        signal.throwIfAborted();
        record = check();
        record = store.markAttempt(record.thread, { scope: record.scope, expectedVersion: record.version }, {
          logicalWorkId, attempt: attempt.attempt, stage: "page-possible",
          launcherInstance: readLauncherContinuityInstance(prepared.descriptor) });
        const recovery = recoveryIdentity(record, store.installationId());
        cleanupIdentity = recovery;
        prepared.recovery = recovery;
        const prepare = async () => {
          signal.throwIfAborted(); check();
          return { ...compiled!, release() {} };
        };
        browser = worker.run({ traceId, modelId: parsed.modelId, reasoning: parsed.options.reasoning,
          ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
          capabilities: { ...capabilities, localToolsEnabled: false }, nativeConnector: true,
          continuity: { owner: prepared.bindings.owner, recovery }, conversationKey: prepared.conversationKey,
          retainConversation: true, compaction: true, prepare, prepareResume: prepare,
          onContinuityLease(lease) {
            const current = check();
            if (lease.traceId !== traceId || !lease.recovery || !sameContinuityRecoveryIdentity(lease.recovery, recovery)) {
              throw continuityError("continuity_source_unproven");
            }
            store.markAttempt(current.thread, { scope: current.scope, expectedVersion: current.version }, {
              logicalWorkId: logicalWorkId!, attempt: attempt.attempt, stage: "page-acquired", pageReceiptId: lease.leaseId });
            prepared.bindings.acceptLease(prepared.binding, lease);
          },
          async onSendActivated() {
            const current = check();
            store.markAttempt(current.thread, { scope: current.scope, expectedVersion: current.version }, {
              logicalWorkId: logicalWorkId!, attempt: attempt.attempt, stage: "send-possible" });
            await markLauncherContinuitySendPossible(prepared.descriptor, recovery);
            check();
            if (!reportedRecovery) {
              reportedRecovery = true;
              try { onRecovered?.(); } catch { /* An observer can detach without stopping this transaction. */ }
            }
          },
          onSubmitted() {
            const current = check();
            store.markAttempt(current.thread, { scope: current.scope, expectedVersion: current.version }, {
              logicalWorkId: logicalWorkId!, attempt: attempt.attempt, stage: "accepted" });
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
      signal.throwIfAborted(); check();
      const checkpoint = commitRecoveryCompaction(parsed, prepared, plan, logicalWorkId, summary, plan.preserveFinalResponse);
      prepared.bindings.installRecoveryCheckpoint(prepared.binding, prepared.executionKey, checkpoint, summary,
        plan.sourceRevision, representations(parsed, plan, summary), plan.preserveFinalResponse);
      onProgress?.();
      return summary;
    } catch (error) {
      browserAbort.abort(error);
      // Physical cleanup remains in the owner gate. A deadline cannot wait forever for it.
      const physical = browser?.then(() => undefined, () => undefined);
      if (physical) retainOwnershipUntil(physical);
      if (transaction) owner.abortCompactionTransaction(transaction.token);
      if (logicalWorkId && attemptNumber !== undefined) {
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
            try { retired = (await retireLauncherContinuityWriter(prepared.descriptor, cleanupIdentity)).writerRetired; }
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
      if (transaction) owner.abortCompactionTransaction(transaction.token);
    }
  });
  return running.catch(error => {
    assertRecoveryCompactionNotStopped(parsed, prepared);
    if (["client_cancelled", "continuity_stopped"].includes(String((error as { code?: string })?.code))) {
      const record = prepared.bindings.recoveryStore.get(prepared.binding.thread);
      if (record?.works[plan.source.logicalWorkId]) {
        prepared.bindings.recoveryStore.stopWork(record.thread, { scope: record.scope }, plan.source.logicalWorkId, "native-interrupt");
      }
    }
    if (error instanceof ChatGptWebAdapterError) throw error;
    throw continuityError("continuity_source_unproven", "The handoff did not commit; already accepted results were not re-executed.");
  });
}
