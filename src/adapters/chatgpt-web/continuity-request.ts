import { recoveryContinuationPrimaryIndices } from "./continuity-source";
import { isReadableCompactionSummaryText } from "../../responses/compaction";
import { parseRequest } from "../../responses/parser";
import { chatGptCurrentInstructionRevision } from "./environment";
import { existsSync, lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { selectRecoveryContinuation } from "./continuity-recovery-continuation";
import { acquireContinuityStorageLock, continuityProcessInstance, continuityProcessInstanceStatus, type RecoveryThreadRecord, type RecoveryWorkRecord, type RecoveryTaskInputRetry } from "./continuity-recovery-store";
import { recoveryContext, recoveryDigest, recoveryIdentity, retireRecoveryWriter, forgetRecoveryPage, type RuntimeRecoveryReference } from "./continuity-recovery-runtime";
import type { ContinuityRecoveryIdentity } from "./continuity-contract";
import { join, resolve } from "node:path";
import { estimateTokens } from "../../lib/token-estimate";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { expandUserPath } from "../../config";
import {
  assertLauncherContinuityCapacity, assertLauncherContinuityFeature, inspectLauncherContinuityConversation,
  readLauncherBrowserHostDescriptor, queryLauncherContinuityTransaction, updateLauncherContinuityPreparation, retireLauncherContinuityWriter,
  terminateLauncherContinuityPreparation,
} from "../../launcher-browser-host";
import type { CodexParsedRequest, CodexProviderConfig } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import { canonicalJson } from "./canonical-json";
import { contextCandidateCanonicalSource, contextCandidateSourceProvenance, continuityAcceptedContextCandidate, continuityContextCandidate, continuityRecoveredContextCandidate } from "./context-candidate-mapping";
import { contextSourceParserModel } from "./context-source-parser";
import { CompactionSourceCoverage } from "./compaction-context";
import { createContextSnapshot } from "./context-snapshot";
import type { ChatGptBrowserWorker } from "./browser-worker";
import {
  continuityBindingsFor, continuityCheckpoint, continuityDigest, continuitySourceRepresentationDigest,
  selectContinuityCheckpoint, type ContinuityCheckpointCommit, type ContinuityCheckpointSelection, type ContinuityBinding, type ContinuityBindings,
} from "./continuity-binding";
import { isContinuityLease, sameContinuityLauncherInstance, sameContinuityRecoveryIdentity, type ContinuityClaim, type ContinuityLease } from "./continuity-contract";
import { continuityError } from "./continuity-errors";
import { captureTaskUpdateSource, taskUpdateDigest, taskUpdateSourceError } from "./task-update-source";
import { ContinuityTaskInputStore, type TaskInputIdentity } from "./continuity-task-input-store";
import { continuityToolRegistry } from "./continuity-tools";
import { isAcceptedCompactionContinuation } from "./compaction-continuation";
import { existingStructuredCompactionRun, hasActiveStructuredCompactionRun, registerStructuredCompactionPage } from "./compaction-handoff";
import { preflightContinuityInput } from "./continuity-input";
import { chatGptConversationKey } from "./conversation-key";
import {
  chatGptCurrentInstructionIndex, chatGptInstructionContent, chatGptInstructionEnvelope, bindDurableQueuedInstructionInput, trustedChatGptTaskUpdateUserText,
  continuityCurrentEnvironmentInput, continuityCurrentInstructionInput, extractChatGptTurnIdentity, requestCarriedChatGptInstructionRevision,
  hasInitialChatGptTurnInstruction, hasNativeChatGptInstruction, continuityCheckpointSiblings, continuityCheckpointSiblingGroup, continuityCheckpointSiblingProof, bindContinuityCheckpointSourceIndex, CONTINUITY_CHECKPOINT_SIBLING_PROOF,
} from "./environment";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "./model";
import {
  chatGptCompactionSourceExecutionKey, chatGptDelegatedCompactionSourceExecutionKey,
  chatGptContinuityInstructionPayloadDigest, chatGptTurnExecutionKey, chatGptTurnSessions,
  continuityInstructionIdentity,
  type ChatGptContinuityInstructionPrevious, type ChatGptTurnSession,
} from "./turn-execution";

export interface PreparedContinuityRequest {
  bindings: ContinuityBindings;
  binding: ContinuityBinding;
  descriptor: string;
  conversationKey: string;
  executionKey: string;
  nativeThreadId: string;
  revision: number;
  sourceExecutionKey?: string;
  expected?: ContinuityLease;
  /** Undefined for exact replay/tool rounds and compaction: no ordinary prompt may be sent. */
  input?: CodexParsedRequest;
  instructionPrevious?: ChatGptContinuityInstructionPrevious;
  allowRetainedSourceInstructionPayload?: boolean;
  finalReplaySource?: ChatGptTurnSession;
  durableFinalReplay?: ChatGptTurnSession;
  verifiedSourceGeneration?: number;
  checkpointTransition?: ContinuityCheckpointSelection;
  appendSource?: ChatGptTurnSession;
  recovery?: ContinuityRecoveryIdentity;
  recovered?: boolean;
  /** Current-source proof for a user-created intent; initial prompt coverage only. */
  taskInputRetry?: { identity: TaskInputIdentity; intentGeneration: number; messageIds: string[] };
  /** The exact accepted checkpoint selected for this recovery input. */
  recoveryCheckpointId?: string;
  releaseAdmission?: () => void;
}

function sameLease(left: ContinuityLease | undefined, right: ContinuityLease | undefined): boolean {
  return left?.owner === right?.owner && left?.leaseId === right?.leaseId && left?.traceId === right?.traceId;
}

/** Request or retained bytes must cover the accepted source ledger before any
 * execution handoff. A canonical object alone is not proof of complete history. */
function assertRecoveredSource(parsed: CodexParsedRequest, input: CodexParsedRequest,
  record: RecoveryThreadRecord, work: RecoveryThreadRecord["works"][string], historyRevision: number): void {
  const entries = (record.contextCoverage ?? []).filter(entry => entry.workLineageId === work.workLineageId
    && entry.metadata.delivered);
  if (!entries.length) return;
  if (entries.some(entry => entry.metadata.historyRevision !== historyRevision || entry.sourceTaskRevision > work.acceptedTaskRevision)) {
    throw continuityError("continuity_source_unproven", "The recovered source omits an accepted history or instruction revision.");
  }
  const canonical = contextCandidateCanonicalSource(parsed, input) ?? input;
  const snapshot = createContextSnapshot(canonical, { imageStoragePolicy: "bounded",
    provenanceByMessage: contextCandidateSourceProvenance(canonical, input) });
  CompactionSourceCoverage.assertRecordedSource(snapshot, entries.map(entry => entry.metadata), historyRevision);
}

export function bindContinuityRequestScope(parsed: CodexParsedRequest, namespace: string): void {
  if (parsed._conversationPolicy === "task") {
    const canonical = continuityDigest([namespace, parsed.modelId, parsed._chatgptModelFamily ?? null, parsed.options.reasoning ?? null]);
    if (parsed._continuityCanonicalScope !== canonical || !parsed._continuityScope) parsed._continuityScope = canonical;
    parsed._continuityCanonicalScope = canonical;
  } else {
    delete parsed._continuityScope;
    delete parsed._continuityCanonicalScope;
  }
}

function ordinaryResumeInput(
  parsed: CodexParsedRequest,
  binding: ContinuityBinding,
  conversationKey: string,
  checkpointProof: ReturnType<typeof continuityCheckpoint>,
): { input: CodexParsedRequest; instructionPrevious: ChatGptContinuityInstructionPrevious } {
  const source = binding.executionKey ? chatGptTurnSessions.find(binding.executionKey) : undefined;
  const outcome = source?.settledOutcome();
  if (!source || source !== chatGptTurnSessions.findConversationHead(conversationKey)
    || !source.isPhysicallySettled() || outcome?.type !== "final" || source.supersededError) {
    throw continuityError("continuity_source_unproven");
  }
  chatGptTurnSessions.assertUnconsumedContinuityInstruction(binding, parsed);
  const instructionPrevious = {
    instructionIdentity: source.acceptedContinuityInstructionIdentity(),
    nativeTurnId: source.nativeTurnId,
    ...(checkpointProof.index >= 0 ? { checkpointDigest: checkpointProof.digest } : {}),
  };
  const suffix = continuityCurrentInstructionInput(parsed, {
    ...instructionPrevious,
    ...(checkpointProof.index >= 0 ? { trustedLowerBound: checkpointProof.index } : {}),
  });
  if (suffix.length === 0) {
    throw continuityError("continuity_source_unproven", "The request has no uniquely located current native instruction.");
  }
  const input = continuityContextCandidate(parsed, [...continuityCurrentEnvironmentInput(parsed, suffix), ...suffix]);
  const messages = input.context.messages;
  if (messages.some(message => message.role === "assistant"
    || (message.role === "toolResult" && message.toolCallId !== undefined))) {
    throw continuityError("continuity_source_unproven", "The current instruction selection contains execution output.");
  }
  return { input, instructionPrevious };
}

function assertNoUnownedTerminalResults(parsed: CodexParsedRequest, checkpointIndex: number,
  accepted?: CodexParsedRequest): void {
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) throw continuityError("continuity_source_unproven");
  const acceptedInput = (accepted?._rawBody as { input?: unknown[] } | undefined)?.input;
  const acceptedItems = new Set(Array.isArray(acceptedInput) ? acceptedInput.map(item => recoveryDigest(item)) : []);
  const lowerBound = Math.max(chatGptCurrentInstructionIndex(parsed), checkpointIndex) + 1;
  for (let index = lowerBound; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const type = (item as { type?: unknown }).type;
    if (type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_search_output") {
      if (acceptedItems.has(recoveryDigest(item))) continue;
      throw continuityError(
        "continuity_source_unproven",
        "The request carries a terminal tool result that is not owned by the current local execution.",
      );
    }
  }
}

function checkpointResumeInput(
  parsed: CodexParsedRequest,
  binding: ContinuityBinding,
  checkpoint: ContinuityCheckpointCommit | undefined,
  proof: ReturnType<typeof continuityCheckpoint>,
  continuation?: { suffix: unknown[]; instructionPrevious: ChatGptContinuityInstructionPrevious },
): {
  input: CodexParsedRequest;
  instructionPrevious: ChatGptContinuityInstructionPrevious;
  allowRetainedSourceInstructionPayload: boolean;
  finalReplaySource?: ChatGptTurnSession;
} {
  if (!checkpoint || (!checkpoint.sourceInstructionReplay && !continuation) || proof.index < 0) throw continuityError("continuity_source_unproven");
  const instructionPrevious = {
    instructionIdentity: continuation?.instructionPrevious.instructionIdentity ?? checkpoint.sourceInstructionReplay!.instructionIdentity,
    nativeTurnId: continuation?.instructionPrevious.nativeTurnId ?? checkpoint.sourceInstructionReplay?.nativeTurnId,
    checkpointDigest: proof.digest,
  };
  // A queued same-turn instruction can arrive after the checkpoint source was
  // frozen. Its durable ID/body prefix establishes the boundary independently
  // of the removed source message; ordinary wire history cannot establish it.
  const native = extractChatGptTurnIdentity(parsed);
  const rawInput = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!continuation && checkpoint.revision === binding.revision && proof.digest === continuityDigest(checkpoint.summary)
    && parsed._continuityScope === binding.scope && parsed._continuityStateDirectory
    && native.threadId && continuityDigest(native.threadId) === binding.thread && native.turnId
    && proof.index === 0 && Array.isArray(rawInput) && rawInput.length > 1) {
    const inbox = new ContinuityTaskInputStore(parsed._continuityStateDirectory);
    const identity = { thread: binding.thread, scope: binding.scope, taskId: `task_${taskUpdateDigest([binding.thread, native.turnId])}` };
    const task = inbox.get(identity);
    const pending = task?.state === "active" ? task.messages.filter(message => message.status === "accepted"
      && !message.deliveryIds.some(id => task.deliveries.some(delivery => delivery.deliveryId === id
        && !delivery.cancelled && delivery.intentGeneration === task.intentGeneration))) : [];
    const suffix = rawInput.slice(1);
    if (suffix.length <= 16 && suffix.length <= pending.length && suffix.every((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const user = trustedChatGptTaskUpdateUserText(value as Record<string, unknown>, native.turnId!);
      return user && user.sourceMessageId === pending[index]!.messageId
        && taskUpdateDigest(user.content) === pending[index]!.digest
        && inbox.readBody(identity, user.sourceMessageId) === user.content;
    })) bindDurableQueuedInstructionInput(parsed, suffix.map((_, index) => index + 1));
  }
  const suffix = continuation?.suffix ?? continuityCurrentInstructionInput(parsed, { ...instructionPrevious, trustedLowerBound: proof.index });
  const hasNewInstruction = hasInitialChatGptTurnInstruction(parsed) && hasNativeChatGptInstruction(parsed, suffix);
  if (hasNewInstruction) chatGptTurnSessions.assertUnconsumedContinuityInstruction(binding, parsed);
  else if (continuityInstructionIdentity(parsed) !== instructionPrevious.instructionIdentity) {
    throw continuityError("continuity_source_unproven", "The checkpoint continuation does not identify its committed source instruction.");
  }
  const inputItems = [...continuityCurrentEnvironmentInput(parsed, suffix), ...suffix];
  const input = continuityContextCandidate(parsed, inputItems);
  const messages = input.context.messages;
  if (messages.some(message => message.role === "assistant"
    || (message.role === "toolResult" && message.toolCallId !== undefined))) {
    throw continuityError("continuity_source_unproven", "The checkpoint continuation contains execution output.");
  }
  if (!checkpoint.preserveFinalResponse || hasNewInstruction) {
    return { input, instructionPrevious, allowRetainedSourceInstructionPayload: !hasNewInstruction };
  }
  const source = chatGptTurnSessions.find(checkpoint.sourceExecutionKey);
  if (!source || source.supersededError || source.settledOutcome()?.type !== "final" || !source.isPhysicallySettled()) {
    throw continuityError("continuity_source_unproven", "The accepted ordinary answer is no longer available for replay.");
  }
  return { input, instructionPrevious, allowRetainedSourceInstructionPayload: true, finalReplaySource: source };
}

/** A new task needs the committed boundary's identity, not the lost source's replay body. */
function recoveredCheckpointNewInstruction(
  parsed: CodexParsedRequest, bindings: ContinuityBindings, binding: ContinuityBinding,
  checkpoint: ContinuityCheckpointCommit | undefined, proof: ReturnType<typeof continuityCheckpoint>,
): { suffix: unknown[]; instructionPrevious: ChatGptContinuityInstructionPrevious } | undefined {
  if (!checkpoint || checkpoint.sourceInstructionReplay) return undefined;
  const identity = extractChatGptTurnIdentity(parsed);
  const instruction = chatGptCurrentInstructionRevision(parsed);
  const record = bindings.recoveryStore.get(binding.thread);
  const matches = Object.values(record?.checkpoints ?? {}).filter(value => value.targetHistoryRevision === binding.revision
    && value.sourceHistoryRevision === checkpoint.sourceRevision && value.summaryDigest === proof.digest);
  const committed = matches.length === 1 ? matches[0] : undefined;
  const source = committed && record?.works[committed.sourceLogicalWorkId];
  if (!record || !committed || !source || proof.index < 0 || checkpoint.revision !== binding.revision
    || continuityDigest(checkpoint.summary) !== proof.digest || record.historyRevision !== binding.revision
    || record.scope !== binding.scope || parsed._continuityScope !== binding.scope
    || !identity.threadId || record.thread !== continuityDigest(identity.threadId)
    || record.owner.id !== binding.owner || record.owner.id !== bindings.owner || record.epoch !== binding.epoch
    || record.currentWorkId !== `compaction:${committed.compactionTargetId}`
    || record.lineages[source.workLineageId]?.headLogicalWorkId !== source.logicalWorkId
    || source.instructionIdentity !== committed.sourceIdentity || source.acceptedTaskRevision !== committed.acceptedTaskRevision
    || !binding.lease?.recovery || !sameContinuityRecoveryIdentity(binding.lease.recovery,
      recoveryIdentity(record, bindings.recoveryStore.installationId()))
    || !instruction || (instruction.turnId !== undefined && instruction.turnId !== identity.turnId)
    || chatGptCurrentInstructionIndex(parsed) <= proof.index || !hasInitialChatGptTurnInstruction(parsed)
    || Object.values(record.works).some(work => work.purpose === "ordinary"
      && work.instructionIdentity === continuityInstructionIdentity(parsed))) {
    throw continuityError("continuity_source_unproven", "The new instruction has no exact current committed checkpoint boundary.");
  }
  // Compare only request-carried producer bytes. This read-only projection grants no
  // writer and does not fill the identity-only source with invented instruction text.
  const raw = parsed._rawBody as { input: unknown[] };
  const prefixBody = { ...raw, input: raw.input.slice(0, proof.index + 1) };
  const prefix = { ...parsed, _compactionRequest: true, _rawBody: prefixBody,
    context: parseRequest({ ...prefixBody, model: contextSourceParserModel(parsed) }).context };
  const carried = requestCarriedChatGptInstructionRevision(prefix, source.nativeTurnId);
  if (carried && !committed.representationDigests.includes(continuitySourceRepresentationDigest(prefix, carried))) {
    throw continuityError("continuity_source_unproven", "The checkpoint producer conflicts with its accepted source.");
  }
  const summaryTurn = (raw.input[proof.index] as { internal_chat_message_metadata_passthrough?: { turn_id?: unknown } })
    .internal_chat_message_metadata_passthrough?.turn_id;
  if (summaryTurn !== undefined && summaryTurn !== source.nativeTurnId && summaryTurn !== checkpoint.sourceInstruction?.turnId
    && summaryTurn !== committed.continuation.nativeTurnId && summaryTurn !== identity.turnId) {
    throw continuityError("continuity_source_unproven", "The checkpoint representation belongs to a different native source.");
  }
  for (const value of (prefix._rawBody as { input: unknown[] }).input) {
    const sibling = continuityCheckpointSiblingProof(prefix, value);
    if (sibling?.identity && committed.representationDigests.includes(sibling.identity)
      && !committed.representationDigests.includes(sibling.representation)) {
      throw continuityError("continuity_source_unproven", "The checkpoint sibling conflicts with its accepted source.");
    }
  }
  const sourceIndex = (prefix._rawBody as { input: unknown[] }).input.findLastIndex(value => hasNativeChatGptInstruction(prefix, [value]));
  const siblings = continuityCheckpointSiblings(prefix, source.instructionPrevious, sourceIndex);
  if (committed.representationDigests.includes(CONTINUITY_CHECKPOINT_SIBLING_PROOF)
    && !committed.representationDigests.includes(continuityCheckpointSiblingGroup(siblings))) {
    throw continuityError("continuity_source_unproven", "The checkpoint sibling group differs from its accepted source.");
  }
  const instructionPrevious = { instructionIdentity: source.instructionIdentity, nativeTurnId: source.nativeTurnId,
    checkpointDigest: proof.digest };
  const suffix = continuityCurrentInstructionInput(parsed, { ...instructionPrevious, trustedLowerBound: proof.index });
  if (!hasNativeChatGptInstruction(parsed, suffix)) throw continuityError("continuity_source_unproven");
  return { suffix, instructionPrevious };
}

function assertCheckpointSourceReplay(parsed: CodexParsedRequest, identity: ReturnType<typeof extractChatGptTurnIdentity>, checkpoint?: ContinuityCheckpointCommit): void {
  const sourceReplay = checkpoint?.sourceInstructionReplay;
  // The retained source remains protected even before the checkpoint and on cached retries.
  if (!parsed._compactionRequest && sourceReplay && continuityInstructionIdentity(parsed) === sourceReplay.instructionIdentity) {
    for (const value of (parsed._rawBody as { input: unknown[] }).input) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      const canonicalId = typeof item.id === "string" ? parsed._chatGptMessageIdAliases?.[item.id] ?? item.id : undefined;
      const turnId = (item.internal_chat_message_metadata_passthrough as { turn_id?: unknown } | undefined)?.turn_id;
      if (canonicalId !== sourceReplay.instructionIdentity
        && !(sourceReplay.instructionIdentity === `turn:${sourceReplay.nativeTurnId}`
          && turnId === sourceReplay.nativeTurnId && hasNativeChatGptInstruction(parsed, [item]))) continue;
      const envelope = chatGptInstructionEnvelope(item);
      const content = chatGptInstructionContent(item);
      if (!hasNativeChatGptInstruction(parsed, [item])
        || (continuityDigest({ turnId: turnId ?? null, ...envelope, content }) !== sourceReplay.sourceDigest
          && !isAcceptedCompactionContinuation(parsed, identity, {
            itemId: typeof item.id === "string" ? item.id : undefined, turnId: turnId as string | undefined,
            instructionEnvelope: envelope, content,
          }))) {
        throw continuityError("continuity_source_unproven", "The checkpoint source instruction conflicts with its accepted native payload.");
      }
    }
  }
}

function explicitTaskInputRetry(parsed: CodexParsedRequest, record?: RecoveryThreadRecord): RecoveryTaskInputRetry | undefined {
  const native = extractChatGptTurnIdentity(parsed);
  if (!native.threadId || !native.turnId || !parsed._continuityStateDirectory || !parsed._continuityScope || parsed._compactionRequest) return;
  const identity = { thread: continuityDigest(native.threadId), scope: record?.scope ?? parsed._continuityScope,
    taskId: `task_${taskUpdateDigest([continuityDigest(native.threadId), native.turnId])}` };
  const task = new ContinuityTaskInputStore(parsed._continuityStateDirectory).get(identity);
  if (!task) return;
  if (task.retired) throw continuityError("continuity_stopped");
  if (task.state === "stopped") throw continuityError("continuity_stopped");
  const selected = task.messages.filter(message => message.intentGeneration === task.intentGeneration && message.retryOfIntentGeneration !== undefined);
  if (!selected.length) return;
  const proof = captureTaskUpdateSource(parsed, { capabilityIdentity: "explicit-task-input-retry" });
  const carried = proof?.messages.filter(message => selected.some(saved => saved.messageId === message.sourceMessageId));
  if (!proof || proof.conflictingMessageIds?.length || proof.currentMessageId !== selected.at(-1)!.messageId
    || canonicalJson(carried?.map(message => [message.sourceMessageId, message.payloadDigest]))
      !== canonicalJson(selected.map(message => [message.messageId, message.digest]))) throw continuityError("continuity_stopped",
        "The explicit retry is waiting for the original client request with the complete selected input.");
  if (!record) {
    const historical = task.messages.filter(message => message.status !== "discarded");
    const carriedHistory = proof.messages.filter(message => historical.some(saved => saved.messageId === message.sourceMessageId));
    if (canonicalJson(carriedHistory.map(message => [message.sourceMessageId, message.payloadDigest]))
      !== canonicalJson(historical.map(message => [message.messageId, message.digest]))) throw continuityError("continuity_source_unproven", "Cold retry requires the complete original native task input history.");
    const calls = proof.input.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"
      && ["function_call", "custom_tool_call", "tool_search_call"].includes(String((item as Record<string, unknown>).type))));
    const results = proof.input.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"
      && ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(String((item as Record<string, unknown>).type))));
    if (calls.some(call => typeof call.call_id !== "string" || !results.some(result => result.call_id === call.call_id))) {
      throw continuityError("continuity_execution_unsettled", "Cold retry requires actual results for every historical tool call; no old call will be dispatched again.");
    }
    return { taskId: identity.taskId, intentGeneration: task.intentGeneration,
      messageIds: selected.map(message => message.messageId), messageDigests: selected.map(message => message.digest) };
  }
  const current = record.currentWorkId ? record.works[record.currentWorkId] : undefined;
  const retry = current?.taskInputRetry;
  const sourceLogicalWorkId = retry?.intentGeneration === task.intentGeneration && retry.taskId === identity.taskId
    ? retry.sourceLogicalWorkId : current?.logicalWorkId;
  if (!sourceLogicalWorkId && !retry) throw continuityError("continuity_source_unproven");
  return { taskId: identity.taskId, intentGeneration: task.intentGeneration, sourceLogicalWorkId,
    messageIds: selected.map(message => message.messageId), messageDigests: selected.map(message => message.digest) };
}

/** Reject a retired source before page inspection or retirement can affect its successor. */
function taskInputRequestIdentity(parsed: CodexParsedRequest): TaskInputIdentity | undefined {
  const native = extractChatGptTurnIdentity(parsed);
  if (parsed._conversationPolicy !== "task" || !native.threadId || !native.turnId || !parsed._continuityScope) return;
  const thread = continuityDigest(native.threadId), taskId = `task_${taskUpdateDigest([thread, native.turnId])}`;
  return { thread, scope: parsed._continuityScope, taskId };
}
function assertTaskInputSourceNotRetired(parsed: CodexParsedRequest, directory: string): void {
  const identity = taskInputRequestIdentity(parsed);
  if (!identity) return;
  const { thread, taskId } = identity;
  const store = new ContinuityTaskInputStore(directory);
  let task: ReturnType<ContinuityTaskInputStore["get"]>;
  try {
    task = store.get(identity);
    if (!task) {
      const record = continuityBindingsFor(directory).recoveryStore.get(thread);
      if (record && (record.canonicalScope === parsed._continuityCanonicalScope || parsed._continuityLegacyScopes?.includes(record.scope))) {
        task = store.get({ thread, scope: record.scope, taskId });
      }
    }
  } catch (error) {
    // A legacy page journal may be repaired below only if no inbox has ever
    // reserved input. The payload directory survives body cleanup and deletion.
    try { lstatSync(join(directory, "task-input-payloads")); }
    catch (markerError) { if ((markerError as NodeJS.ErrnoException).code === "ENOENT") return; }
    throw error;
  }
  if (task?.retired) throw continuityError("continuity_stopped", "This task source has retired. Start a new native turn for new work.");
}

/** A stopped instruction needs an exact user-created retry and fresh current-source admission. */
export function assertContinuityStoppedReceipt(parsed: CodexParsedRequest): void {
  if (parsed._conversationPolicy !== "task" || parsed._compactionRequest
    || !parsed._continuityStateDirectory || !parsed._continuityScope) return;
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId || !identity.turnId) return;
  const record = continuityBindingsFor(parsed._continuityStateDirectory).recoveryStore.get(continuityDigest(identity.threadId));
  if (explicitTaskInputRetry(parsed, record)) return;
  if (!record || record.legacyUnproven || !(record.scope === parsed._continuityScope
    || record.canonicalScope === parsed._continuityCanonicalScope
    || parsed._continuityLegacyScopes?.includes(record.scope))) return;
  // Resolver-established aliases are not available yet. Use only direct native IDs,
  // without caching any checkpoint or instruction interpretation before verification.
  if (continuityCheckpoint(parsed).index >= 0) return;
  const input = (parsed._rawBody as { input?: unknown[] }).input ?? [];
  const instructions = input.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"
    && ["user", "agent_message"].includes(String((item as Record<string, unknown>).role))));
  if (!instructions.length) return;
  const last = instructions.at(-1)!;
  const instruction = typeof last.id === "string" ? parsed._chatGptMessageIdAliases?.[last.id] ?? last.id : `turn:${identity.turnId}`;
  if (Object.values(record.works).some(work => work.purpose === "ordinary" && work.state === "stopped"
    && work.nativeTurnId === identity.turnId && work.instructionIdentity === instruction)) throw continuityError("continuity_stopped");
}

const preparations = new Map<string, Promise<unknown>>();
const admissionLocks = new Map<string, () => void>();
const pageDirectorySweeps = new Map<string, Promise<void>>();
const pageDirectorySweepThreads = new Map<string, string>();
const pageReselections = new WeakMap<CodexParsedRequest, number>();

async function reconcilePageDirectory(bindings: ContinuityBindings, descriptor: string, currentThread: string, parsed: CodexParsedRequest): Promise<void> {
  const directory = bindings.registrations.directory;
  const migrated = bindings.recoveryStore.promotePageLifetime();
  const previous = pageDirectorySweeps.get(directory);
  if (previous && !migrated && pageDirectorySweepThreads.get(directory) === currentThread) return previous;
  let skipped = false;
  const sweep = (previous?.catch(() => {}) ?? Promise.resolve()).then(async () => {
    for (const record of bindings.recoveryStore.pageRecords()) {
      if (record.thread === currentThread) continue;
      if (bindings.observed(record.thread)?.pendingCreation) { skipped = true; continue; }
      let unlock: () => void;
      try { unlock = acquireContinuityStorageLock(join(directory, `${record.thread}.admission.lock`)); }
      catch (error) {
        if (/storage (?:is )?busy/.test(String((error as Error).message))) { skipped = true; continue; }
        throw error;
      }
      try { await reconcilePage(bindings, record.thread, descriptor, parsed); }
      finally { unlock(); }
    }
  });
  pageDirectorySweeps.set(directory, sweep);
  pageDirectorySweepThreads.set(directory, currentThread);
  try {
    await sweep;
    if (skipped && pageDirectorySweeps.get(directory) === sweep) {
      pageDirectorySweeps.delete(directory); pageDirectorySweepThreads.delete(directory);
    }
  }
  catch (error) { if (pageDirectorySweeps.get(directory) === sweep) pageDirectorySweeps.delete(directory); throw error; }
}

/** Serialize selection and admission. Durable CAS also fences other backend processes. */
export async function prepareContinuityRequest(...args: Parameters<typeof prepareContinuityRequestUnlocked>): Promise<PreparedContinuityRequest> {
  const [parsed, provider] = args;
  if (!provider.chatgptWeb?.continuityStateDirectory || !provider.chatgptWeb.browserHostDescriptorPath
    || !extractChatGptTurnIdentity(parsed).threadId
    || !existsSync(resolve(expandUserPath(provider.chatgptWeb.continuityStateDirectory)))) return prepareContinuityRequestUnlocked(...args);
  const rootSelection = !pageReselections.has(parsed);
  if (rootSelection) pageReselections.set(parsed, 0);
  const key = `${provider.chatgptWeb?.continuityStateDirectory}:${extractChatGptTurnIdentity(parsed).threadId}`;
  const previous = preparations.get(key) ?? Promise.resolve();
  let pageSelected!: () => void;
  const selection = new Promise<void>(resolve => { pageSelected = resolve; });
  preparations.set(key, selection);
  const pending = previous.catch(() => {}).then(async () => {
    const directory = provider.chatgptWeb?.continuityStateDirectory;
    const native = extractChatGptTurnIdentity(parsed);
    let release = admissionLocks.get(key);
    const ownsAdmission = !release;
    let creation: ContinuityBinding | undefined;
    if (!release && directory && native.threadId && existsSync(resolve(expandUserPath(directory)))) {
      const unlock = acquireContinuityStorageLock(join(resolve(expandUserPath(directory)), `${continuityDigest(native.threadId)}.admission.lock`));
      release = () => { if (admissionLocks.get(key) === release) {
        admissionLocks.delete(key);
        if (creation && creation.pendingCreation === release) delete creation.pendingCreation;
        unlock();
      } };
      admissionLocks.set(key, release);
      args[5]?.addEventListener("abort", release, { once: true });
    }
    const bindings = continuityBindingsFor(resolve(expandUserPath(directory!)));
    let observedBeforePrepare: RecoveryThreadRecord | undefined;
    const prepare = () => prepareContinuityRequestUnlocked(args[0], args[1], args[2], args[3], args[4], args[5], () => {
      const binding = continuityBindingsFor(resolve(expandUserPath(directory!))).observed(continuityDigest(native.threadId!));
      if (binding?.lease) release?.();
      pageSelected();
    });
    try {
      bindContinuityRequestScope(parsed, args[2]);
      assertTaskInputSourceNotRetired(parsed, bindings.registrations.directory);
      await reconcilePageDirectory(bindings, resolve(expandUserPath(provider.chatgptWeb!.browserHostDescriptorPath!)),
        continuityDigest(native.threadId!), parsed);
      observedBeforePrepare = bindings.recoveryStore.get(continuityDigest(native.threadId!));
      const prepared = await prepare();
      prepared.binding.pageGeneration = parsed._continuityPageGeneration ?? prepared.binding.epoch;
      registerStructuredCompactionPage(native.threadId!, native.turnId!, {
        directory: prepared.bindings.registrations.directory, thread: prepared.binding.thread,
        epoch: prepared.binding.pageGeneration!,
      });
      if (prepared.binding.lease) release?.();
      else if (ownsAdmission) {
        creation = prepared.binding;
        creation.pendingCreation = release;
        prepared.releaseAdmission = release;
      }
      return prepared;
    }
    catch (error) {
      const config = provider.chatgptWeb;
      const threadId = extractChatGptTurnIdentity(parsed).threadId;
      if (parsed._conversationPolicy === "task" && config?.continuityStateDirectory && config.browserHostDescriptorPath && threadId
        && String((error as { code?: string }).code).startsWith("continuity_")) {
        const bindings = continuityBindingsFor(resolve(expandUserPath(config.continuityStateDirectory)));
        const binding = bindings.observed(continuityDigest(threadId));
        if (observedBeforePrepare && !await reconcilePage(bindings, continuityDigest(threadId),
          resolve(expandUserPath(config.browserHostDescriptorPath)), parsed)) {
          // Live selection already released its admission lock. Cold retry must
          // reacquire that same lock before another backend can create a page.
          if (ownsAdmission) release?.();
          pageSelected();
          const reselections = pageReselections.get(parsed) ?? 0;
          if (reselections >= 8) throw continuityError("continuity_unverified", "The page changed repeatedly during this request; retry it.");
          pageReselections.set(parsed, reselections + 1);
          return prepareContinuityRequest(...args);
        }
      }
      if (ownsAdmission) release?.();
      throw error;
    }
  });
  try { return await pending; } finally {
    pageSelected();
    if (preparations.get(key) === selection) preparations.delete(key);
    if (rootSelection) pageReselections.delete(parsed);
  }
}

/** Observe the actual document before interpreting any old task receipt. */
async function reconcilePage(bindings: ContinuityBindings, thread: string, descriptor: string, parsed: CodexParsedRequest): Promise<boolean> {
  const store = bindings.recoveryStore;
  store.promotePageLifetime();
  for (let tries = 0; tries < 8; tries++) {
    const record = store.get(thread);
    const binding = bindings.observed(thread);
    const leaseDigest = continuityDigest(binding?.lease ?? null);
    const executionKey = binding?.executionKey;
    if (!record) {
      store.removeOrphanRegistration(thread);
      if (binding) bindings.forget(binding);
      forgetRecoveryPage(bindings.registrations.directory, thread);
      return false;
    }
    // Local preparations share one pending creation. Its accepted input remains
    // authoritative until that preparation settles or acquires its page.
    if (binding?.state === "creating" && !binding.lease
      && (binding.pendingCreation || hasActiveStructuredCompactionRun(binding.initialExecutionKey))
      && record.owner.id === bindings.owner && record.currentWorkId
      && record.works[record.currentWorkId]?.state !== "stopped"
      && !record.works[record.currentWorkId]?.attempts.at(-1)?.writerRetired) return true;
    let live = false;
    const leaseIdentity = binding?.lease?.recovery;
    const leaseAttempt = leaseIdentity && record.works[leaseIdentity.logicalWorkId]?.attempts[leaseIdentity.attempt];
    // A healthy MCP compaction can finish on the original physical page without
    // replacing its lease. Its retired source attempt still identifies that page;
    // a different epoch or backend owner cannot use this retained tag as evidence.
    const currentLease = leaseIdentity && leaseIdentity.epoch === record.epoch
      && binding?.owner === record.owner.id && leaseAttempt?.epoch === record.epoch
      && leaseIdentity.transactionId === leaseAttempt.transactionId
      && leaseIdentity.transactionVersion === leaseAttempt.transactionVersion
      && leaseIdentity.snapshotVersion === leaseAttempt.snapshotVersion
      && leaseIdentity.snapshotDigest === leaseAttempt.snapshotDigest;
    if (currentLease && binding?.lease && binding.conversation) {
      try {
        const page = await inspectLauncherContinuityConversation(descriptor, binding.conversation.key, binding.lease);
        live = page.state === "ready" || page.state === "running";
      } catch { /* Closed and unknown pages both revoke the old generation. */ }
    }
    if (!live && record.transaction && !record.legacyUnproven) {
      try {
        const identities = [recoveryIdentity(record, store.installationId())];
        if (record.pendingPreparation) identities.push(recoveryIdentity({ ...record, ...record.pendingPreparation.target }, store.installationId()));
        for (const identity of identities) {
          const page = await queryLauncherContinuityTransaction(descriptor, identity, bindings.registrations.directory).catch(() => undefined);
          if (page?.continuity && !["missing", "unknown", "retired"].includes(page.state)) { live = true; break; }
        }
      } catch { /* A historical receipt alone does not prove a live document. */ }
    }
    const current = store.get(thread);
    if (bindings.observed(thread) !== binding || continuityDigest(binding?.lease ?? null) !== leaseDigest
      || binding?.executionKey !== executionKey) continue;
    if (!current || current.epoch !== record.epoch || current.owner.id !== record.owner.id
      || current.transaction?.transactionId !== record.transaction?.transactionId
      || current.transaction?.version !== record.transaction?.version) continue;
    if (live) {
      if (binding && !currentLease && !binding.pendingCreation
        && (binding.owner !== record.owner.id || !binding.recovery || !record.works[binding.recovery.logicalWorkId])) bindings.forget(binding);
      return true;
    }
    // Removal and admission use the same journal lock as dispatch. No old result,
    // stop or ACK can regain authority after this exact generation is removed.
    if (!store.removePage(thread, current)) continue;
    if (binding) bindings.forget(binding);
    forgetRecoveryPage(bindings.registrations.directory, thread);
    const old = record.transaction && !record.legacyUnproven ? recoveryIdentity(record, store.installationId()) : undefined;
    const cleanup: Array<Promise<unknown>> = [];
    if (old) cleanup.push(retireLauncherContinuityWriter(descriptor, old, bindings.registrations.directory).catch(() => {}));
    const work = record.currentWorkId && record.works[record.currentWorkId];
    if (work && bindings.broker?.retireRecoveryWriter) cleanup.push(bindings.broker.retireRecoveryWriter({
      directory: bindings.registrations.directory, thread, logicalWorkId: work.logicalWorkId, attempt: work.attempts.at(-1)!.attempt,
    }).catch(() => {}));
    // Cleanup does not prove external command settlement and does not gate admission.
    await Promise.all(cleanup);
    if (store.get(thread)) continue;
    return false;
  }
  throw continuityError("continuity_unverified", "The current page changed repeatedly during admission; retry the request.");
}

/** A readable request-carried checkpoint can be its own cold task source. */
function bindRequestCheckpointInstruction(parsed: CodexParsedRequest): void {
  delete parsed._continuityRequestInstruction;
  try { if (chatGptCurrentInstructionRevision(parsed)) return; } catch { return; }
  const content = parsed.context.messages.map(message => message.content).find(isReadableCompactionSummaryText);
  if (!content) return;
  parsed._continuityRequestInstruction = { content, turnId: extractChatGptTurnIdentity(parsed).turnId,
    itemId: `request-summary:${continuityDigest(content)}`, instructionEnvelope: { role: "user" } };
}

async function prepareFreshPage(parsed: CodexParsedRequest, namespace: string, capabilities: ChatGptWebCapabilities,
  bindings: ContinuityBindings, descriptor: string, attachments: boolean | undefined, experimentalBiggerContext: boolean | undefined,
  compatible: () => Promise<void>, abortSignal?: AbortSignal): Promise<PreparedContinuityRequest> {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!parsed.context.messages.length) throw continuityError("continuity_context_missing", "The current request has no readable task context.");
  await compatible();
  bindRequestCheckpointInstruction(parsed);
  const retry = explicitTaskInputRetry(parsed);
  const input = retry ? structuredClone(parsed) : parsed;
  if (retry) {
    input.context.systemPrompt = [...input.context.systemPrompt ?? [],
      `Explicit user retry: process only the retried user message IDs ${JSON.stringify(retry.messageIds)} using the current request's permissions. Historical tool calls and real returned results are context only. Do not replay old tool calls or assume a returned command session ID means that the command exited.`];
    continuityRecoveredContextCandidate(parsed, input);
  }
  preflightContinuityInput(input, capabilities, attachments, false, { experimentalBiggerContext });
  await assertLauncherContinuityCapacity(descriptor);
  abortSignal?.throwIfAborted();
  const epoch = Number.parseInt(randomBytes(6).toString("hex"), 16);
  parsed._continuityPageGeneration = input._continuityPageGeneration = epoch;
  parsed._continuityEpoch = input._continuityEpoch = epoch;
  parsed._continuityHistoryRevision = input._continuityHistoryRevision = 0;
  parsed._continuityAttempt = input._continuityAttempt = 0;
  const thread = continuityDigest(identity.threadId!);
  const scope = parsed._continuityScope!;
  const payload = chatGptContinuityInstructionPayloadDigest(parsed);
  const logicalWorkId = retry ? recoveryDigest([scope, identity.turnId, "explicit-input-retry", retry.taskId, retry.intentGeneration])
    : recoveryDigest([scope, identity.turnId, continuityInstructionIdentity(parsed), "ordinary", epoch]);
  const admission = { thread, scope, owner: continuityProcessInstance(bindings.owner),
    logicalWorkId, instructionIdentity: continuityInstructionIdentity(parsed), nativeTurnId: identity.turnId,
    workPayloadDigest: payload, snapshotDigest: recoveryDigest(input.context), createPage: true, dispatchProtocolComplete: true,
    initialEpoch: epoch };
  const record = retry ? bindings.recoveryStore.reserveTaskInputRetry(admission, retry) : bindings.recoveryStore.admitWork(admission);
  parsed._continuityEpoch = input._continuityEpoch = record.epoch;
  parsed._continuityPageGeneration = input._continuityPageGeneration = record.epoch;
  const executionKey = `${namespace}:${chatGptTurnExecutionKey(parsed)}`;
  const binding = bindings.installRecovered(record, executionKey, continuityCheckpoint(parsed).digest, identity.turnId);
  binding.initialAcceptedInput = continuityAcceptedContextCandidate(parsed, input);
  binding.initialInstructionPayloadDigest = payload;
  const conversationKey = chatGptConversationKey(parsed, namespace)!;
  binding.conversation = { key: conversationKey, descriptor };
  return { bindings, binding, descriptor, conversationKey, executionKey, nativeThreadId: identity.threadId!, revision: 0,
    input, recovery: recoveryIdentity(record, bindings.recoveryStore.installationId()), recovered: true,
    ...(retry ? { taskInputRetry: { identity: { thread, scope, taskId: retry.taskId },
      intentGeneration: retry.intentGeneration, messageIds: retry.messageIds } } : {}) };
}

/** Resolves trusted history identity before trace/replay lookup or browser/clipboard mutation. */
async function prepareContinuityRequestUnlocked(
  parsed: CodexParsedRequest,
  provider: CodexProviderConfig,
  namespace: string,
  capabilities: ChatGptWebCapabilities,
  worker: ChatGptBrowserWorker,
  abortSignal?: AbortSignal,
  livePageSelected?: () => void,
): Promise<PreparedContinuityRequest> {
  abortSignal?.throwIfAborted();
  const config = provider.chatgptWeb;
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  if (parsed._conversationPolicy !== "task" || !config?.continuityStateDirectory
    || !config.localToolsEnabled || config.browserHost !== "launcher" || !config.browserHostDescriptorPath
    || (config.browserInteractionMode === "manual") !== manual
    || (!manual && parsed.modelId !== CHATGPT_WEB_MODEL_ID)) throw continuityError("continuity_configuration_conflict");
  const descriptor = resolve(expandUserPath(config.browserHostDescriptorPath));
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId || !identity.turnId) throw continuityError("continuity_source_unproven");
  if (!existsSync(resolve(expandUserPath(config.continuityStateDirectory)))) throw continuityError("continuity_configuration_conflict");
  const bindings = continuityBindingsFor(resolve(expandUserPath(config.continuityStateDirectory)));
  const thread = continuityDigest(identity.threadId);
  bindContinuityRequestScope(parsed, namespace);
  parsed._continuityStateDirectory = bindings.registrations.directory;
  const pageAlive = await reconcilePage(bindings, thread, descriptor, parsed);
  let durable = bindings.recoveryStore.get(thread);
  if (durable && durable.scope !== parsed._continuityScope) {
    const canonicalScope = parsed._continuityCanonicalScope!;
    if (durable.canonicalScope !== canonicalScope && !parsed._continuityLegacyScopes?.includes(durable.scope)) {
      throw continuityError("continuity_configuration_conflict");
    }
    if (durable.canonicalScope !== canonicalScope) durable = bindings.recoveryStore.bindCanonicalScope(thread,
      { expectedScope: durable.scope, canonicalScope, expectedVersion: durable.version });
    parsed._continuityScope = durable.scope;
  }
  const scope = parsed._continuityScope!;
  let binding = bindings.lookup(thread, scope);
  const pendingAttempt = durable?.currentWorkId ? durable.works[durable.currentWorkId]?.attempts.at(-1) : undefined;
  const termination = pendingAttempt?.preparationTermination;
  if (durable && termination && durable.owner.id === bindings.owner && durable.state !== "stopped"
    && (termination.status === "pending" || binding?.state === "unverified" || binding?.state === "running")) {
    try {
      const lease = await terminateLauncherContinuityPreparation(descriptor, termination.recovery, bindings.registrations.directory, termination);
      const settled = bindings.recoveryStore.settlePreparationTermination(termination.recovery, termination.receiptId);
      if (!settled) throw continuityError("continuity_source_unproven");
      if (binding?.executionKey) {
        chatGptTurnSessions.restorePreparationConversationHead(binding.conversation!.key, binding.executionKey, binding.preparationSourceExecutionKey, binding);
        bindings.preparationTerminated(binding, binding.executionKey, binding.preparationSourceExecutionKey, lease);
      }
      durable = settled;
    } catch (error) {
      if ((error as { code?: string }).code === "continuity_session_lost") throw error;
      throw continuityError("continuity_unverified", "Preparation failed. Recovery is awaiting confirmation for the same attempt; no new Send is permitted.");
    }
  }
  if (binding?.initialAcceptedInput?._continuityRequestInstruction) bindRequestCheckpointInstruction(parsed);
  if (durable?.scope !== undefined && durable.scope !== scope) throw continuityError("continuity_configuration_conflict");
  if (durable?.legacyUnproven) throw continuityError("continuity_legacy_unproven");
  let compatible = false;
  const assertExecutionCompatible = async (): Promise<void> => {
    if (compatible) return;
    try {
      assertLauncherContinuityFeature(readLauncherBrowserHostDescriptor(descriptor), true);
      if (!manual) await worker.assertContinuityCompatible();
      compatible = true;
    } catch {
      throw continuityError("continuity_configuration_conflict", "Update and restart Launcher and its helper before starting this mode.");
    }
  };
  if (!parsed._compactionRequest && durable) {
    const retry = explicitTaskInputRetry(parsed, durable);
    if (retry) {
      const prepared = await prepareExplicitTaskInputRetry(parsed, namespace, capabilities, config.experimentalSkillAttachments,
        bindings, durable, retry, descriptor, assertExecutionCompatible, abortSignal, config.experimentalBiggerContext);
      if (prepared) return prepared;
    }
  }
  if (!pageAlive) {
    if (parsed._compactionRequest) {
      const { prepareFreshRecoveryCompaction } = await import("./continuity-recovery-compaction");
      return prepareFreshRecoveryCompaction(parsed, provider, namespace, capabilities, worker, bindings, descriptor,
        abortSignal, assertExecutionCompatible);
    }
    return prepareFreshPage(parsed, namespace, capabilities, bindings, descriptor, config.experimentalSkillAttachments,
      config.experimentalBiggerContext, assertExecutionCompatible, abortSignal);
  }
  livePageSelected?.();
  parsed._continuityPageGeneration = durable ? Math.min(...Object.values(durable.works)
    .flatMap(work => work.attempts.map(attempt => attempt.epoch))) : 0;
  parsed._continuityEpoch = durable?.epoch ?? 0;
  assertContinuityStoppedReceipt(parsed);
  let continuedDelegationSource: RecoveryWorkRecord | undefined;
  if (parsed._compactionRequest) {
    const retained = binding && durable ? {
      executionKey: binding.executionKey, owner: binding.owner, epoch: binding.epoch,
      leaseDigest: continuityDigest(binding.lease ?? null),
      leaseRecovery: binding.lease?.recovery && structuredClone(binding.lease.recovery),
      identity: durable.transaction ? recoveryIdentity(durable, bindings.recoveryStore.installationId()) : undefined,
    } : undefined;
    const { prepareRecoveryCompaction, recoveryCompactionTarget } = await import("./continuity-recovery-compaction");
    const prepared = await prepareRecoveryCompaction(parsed, provider, namespace, capabilities, worker, bindings, durable, descriptor, abortSignal, assertExecutionCompatible);
    if (prepared) return prepared;
    const target = recoveryCompactionTarget(parsed);
    if (target?.source.allowRetainedSourceFallback && target.sourceRevision.instructionEnvelope?.role === "tool_result") {
      continuedDelegationSource = target.source;
    }
    // Retained-source preview yields while reading page usage and source bounds.
    // Its old healthy decision cannot survive a loss callback or a new writer.
    // Recheck here, after the async return, before entering synchronous retained routing.
    abortSignal?.throwIfAborted();
    const current = bindings.recoveryStore.get(thread);
    const source = durable?.currentWorkId ? current?.works[durable.currentWorkId] : undefined;
    if (source?.state === "stopped" || current?.state === "stopped") throw continuityError("continuity_stopped");
    if (!binding || !retained || !durable || !current || bindings.observed(thread) !== binding
      || binding.executionKey !== retained.executionKey || binding.owner !== retained.owner || binding.epoch !== retained.epoch
      || continuityDigest(binding.lease ?? null) !== retained.leaseDigest
      || current.scope !== durable.scope || current.owner.id !== durable.owner.id || current.epoch !== durable.epoch
      || current.historyRevision !== durable.historyRevision || current.currentWorkId !== durable.currentWorkId
      || source?.acceptedTaskRevision !== durable.works[durable.currentWorkId!]?.acceptedTaskRevision
      || source?.workPayloadDigest !== durable.works[durable.currentWorkId!]?.workPayloadDigest
      || retained.identity && (!current.transaction || !sameContinuityRecoveryIdentity(retained.identity,
        recoveryIdentity(current, bindings.recoveryStore.installationId())))) {
      const target = recoveryCompactionTarget(parsed)?.target;
      // The same compaction can advance the writer while this preview is suspended.
      // Only observe that exact target; a newer ordinary task or foreign owner stays fenced.
      if (target && durable && current && target.sourceLogicalWorkId === durable.currentWorkId
        && current.currentWorkId === `compaction:${target.compactionTargetId}`
        && current.owner.id === durable.owner.id && current.owner.id === bindings.owner
        && source?.acceptedTaskRevision === durable.works[durable.currentWorkId!]?.acceptedTaskRevision
        && source?.workPayloadDigest === durable.works[durable.currentWorkId!]?.workPayloadDigest) {
        const observed = await prepareRecoveryCompaction(parsed, provider, namespace, capabilities, worker, bindings, current,
          descriptor, abortSignal, assertExecutionCompatible, target.compactionTargetId);
        if (observed) return observed;
      }
      throw continuityError("continuity_source_unproven");
    }
    if (binding.state === "lost" || current.state === "lost") {
      if (!retained.identity || !retained.leaseRecovery
        || !sameContinuityRecoveryIdentity(retained.identity, retained.leaseRecovery)) throw continuityError("continuity_source_unproven");
      const recovered = await prepareRecoveryCompaction(parsed, provider, namespace, capabilities, worker, bindings, current,
        descriptor, abortSignal, assertExecutionCompatible);
      if (recovered) return recovered;
      throw continuityError("continuity_session_lost");
    }
  }
  const initialLocalOwner = binding?.executionKey ? chatGptTurnSessions.find(binding.executionKey) : undefined;
  if (!parsed._compactionRequest && initialLocalOwner?.nativeTurnId === identity.turnId) initialLocalOwner.bindContinuityResultSource(parsed);
  if (!parsed._compactionRequest && durable) {
    const checkpointPrepared = await prepareDurableContinuation(parsed, namespace, capabilities, config.experimentalSkillAttachments, bindings, durable, descriptor, abortSignal, assertExecutionCompatible, Boolean(config.experimentalFreshConversationPerTurn), config.experimentalBiggerContext);
    if (checkpointPrepared) return checkpointPrepared;
    const recovered = await prepareDurableOrdinary(parsed, namespace, capabilities, config.experimentalSkillAttachments, bindings, durable, descriptor, abortSignal, assertExecutionCompatible, config.experimentalBiggerContext);
    if (recovered) return recovered;
    binding = bindings.lookup(thread, scope);
  }
  parsed._continuityEpoch = binding?.epoch ?? durable?.epoch ?? 0;
  const currentInstruction = !parsed._compactionRequest ? continuityInstructionIdentity(parsed) : undefined;
  const currentWork = currentInstruction && durable ? Object.values(durable.works).find(work => work.instructionIdentity === currentInstruction && work.nativeTurnId === identity.turnId && work.purpose === "ordinary") : undefined;
  if (currentWork) parsed._continuityAttempt = currentWork.attempts.at(-1)!.attempt
    + (currentWork.attempts.at(-1)!.preparationTermination?.status === "settled" ? 1 : 0);
  const localOwner = binding?.executionKey ? chatGptTurnSessions.find(binding.executionKey) : undefined;
  const appendSource = !parsed._compactionRequest && localOwner?.isActive()
    && localOwner.nativeThreadId === identity.threadId && localOwner.nativeTurnId === identity.turnId
    && localOwner.runtime.continuityBinding === binding && !localOwner.supersededError
    ? localOwner : undefined;
  if (!parsed._compactionRequest && localOwner?.nativeTurnId === identity.turnId) localOwner.bindContinuityResultSource(parsed);
  const checkpointSelection = selectContinuityCheckpoint(parsed, identity);
  const checkpointProof = continuityCheckpoint(parsed);
  const checkpoint = checkpointProof.digest;
  const revisionCandidates = binding ? bindings.revisionsFor(binding, checkpoint) : [0];
  const keyedCandidates = revisionCandidates.map(revision => {
    parsed._continuityHistoryRevision = revision;
    try { return { revision, executionKey: `${namespace}:${chatGptTurnExecutionKey(parsed)}` }; }
    catch { throw continuityError("continuity_source_unproven"); }
  });
  let selected = keyedCandidates[0]!;
  if (binding && keyedCandidates.length > 1) {
    const exact = keyedCandidates.filter(candidate => parsed._compactionRequest
      ? binding!.checkpoints.has(candidate.executionKey) || Boolean(existingStructuredCompactionRun(candidate.executionKey))
      : Boolean(chatGptTurnSessions.find(candidate.executionKey)));
    const reclaimed = parsed._compactionRequest ? [] : keyedCandidates.filter(candidate => (
      binding!.ordinaryReplayTombstones.get(candidate.executionKey)?.revision === candidate.revision
    ));
    const transitionTargets = parsed._compactionRequest || !checkpointSelection ? [] : keyedCandidates.filter(candidate => (
      candidate.revision === checkpointSelection.checkpoint.revision
    ));
    const checkpointOnly = checkpointProof.index >= 0
      && !hasNativeChatGptInstruction(parsed, continuityCurrentInstructionInput(parsed, { trustedLowerBound: checkpointProof.index }));
    const resultRounds = parsed._compactionRequest ? [] : keyedCandidates.filter(candidate => {
      const session = chatGptTurnSessions.find(candidate.executionKey);
      if (!session) return false;
      try { return session.continuityToolResultRoundKey(parsed) !== undefined; }
      catch { return false; }
    });
    if (resultRounds.length > 1) {
      throw continuityError("continuity_source_unproven", "The tool result group matches more than one retained history revision.");
    }
    if (resultRounds.length === 1) {
      selected = resultRounds[0]!;
    } else if (checkpointOnly && transitionTargets.length > 1) {
      throw continuityError("continuity_source_unproven", "The checkpoint matches more than one committed source transition.");
    } else if (checkpointOnly && transitionTargets.length === 1) {
      selected = transitionTargets[0]!;
    } else {
      const matchedRevisions = new Set([...exact, ...reclaimed].map(candidate => candidate.revision));
      if (matchedRevisions.size > 1) {
        throw continuityError("continuity_source_unproven", "The request matches more than one retained history revision.");
      }
      selected = exact[0] ?? reclaimed[0] ?? keyedCandidates.find(candidate => candidate.revision === binding!.revision)!;
      if (!selected) throw continuityError("continuity_source_unproven");
    }
  }
  const { revision, executionKey } = selected;
  const selectedCheckpoint = checkpointProof.index >= 0
    ? checkpointSelection?.checkpoint.revision === revision ? checkpointSelection.checkpoint
      : [...binding?.checkpoints.values() ?? []].find(value => value.revision === revision) : undefined;
  if (!appendSource?.taskUpdatesEnabled()) assertCheckpointSourceReplay(parsed, identity, selectedCheckpoint);
  parsed._continuityHistoryRevision = revision;
  let conversationKey = chatGptConversationKey(parsed, namespace)!;
  let existing = chatGptTurnSessions.find(executionKey);
  if (binding && !parsed._compactionRequest && !existing
    && binding.ordinaryReplayTombstones.get(executionKey)?.revision === revision) {
    throw continuityError(
      "continuity_source_unproven",
      "The exact ordinary replay result was reclaimed; the request cannot be re-executed.",
    );
  }
  if (!binding && !hasInitialChatGptTurnInstruction(parsed)) throw continuityError("continuity_source_unproven");
  if (binding && !parsed._compactionRequest && existing) {
    existing.assertCanonicalReplayInput(parsed);
    if (!existing.taskUpdatesEnabled()) existing.continuityRoundKey(parsed);
  }
  if (binding && revision !== binding.revision
    && !(parsed._compactionRequest && binding.checkpoints.has(executionKey))
    && !existing?.roundCompleted(existing.continuityRoundKey(parsed))) {
    throw continuityError("continuity_source_unproven", "An older history revision cannot start new work.");
  }
  // Keep the existing history and round selectors ahead of browser dependency checks.
  const readonlyReplay = parsed._compactionRequest ? binding?.checkpoints.has(executionKey)
    : existing?.roundCompleted(existing.continuityRoundKey(parsed));
  // Pin the source before compatibility, page inspection, usage sync and capacity
  // checks yield. A cold-page decision may retire only this observed writer.
  const ordinarySourceObservation = !parsed._compactionRequest && binding && !existing ? {
    record: bindings.recoveryStore.get(thread), owner: binding.owner, epoch: binding.epoch,
    revision: binding.revision, executionKey: binding.executionKey,
    lease: binding.lease ? structuredClone(binding.lease) : undefined,
  } : undefined;
  if (!readonlyReplay) await assertExecutionCompatible();
  let expected = binding?.lease ? { ...binding.lease } : undefined;
  const sourceExecutionKey = binding?.executionKey;
  let verifiedSourceGeneration: number | undefined;
  const exactCurrentWork = (): boolean => Boolean(binding && (parsed._compactionRequest
    ? (binding.compactionKey === executionKey || binding.checkpoints.has(executionKey)) && existingStructuredCompactionRun(executionKey)
      : (binding.executionKey === executionKey || appendSource === localOwner) && chatGptTurnSessions.find(binding.executionKey!)));
  if (parsed._compactionRequest && binding && !binding.checkpoints.has(executionKey)
    && !(binding.state === "compacting" && binding.compactionKey === executionKey)) {
    let candidate: string | undefined;
    try {
      candidate = config.toolAuthorityMode === "delegated"
        ? chatGptDelegatedCompactionSourceExecutionKey(parsed)
        : chatGptCompactionSourceExecutionKey(parsed);
    } catch { /* A missing or malformed source is not a retained-page creation authority. */ }
    const source = sourceExecutionKey ? chatGptTurnSessions.find(sourceExecutionKey) : undefined;
    // A consumed delegation checkpoint binds the original source instruction to a new
    // native consumer turn. Its proven work relation identifies the current execution.
    const matchesContinuedDelegation = continuedDelegationSource
      && binding.recovery?.logicalWorkId === continuedDelegationSource.logicalWorkId
      && source?.nativeTurnId === continuedDelegationSource.nativeTurnId
      && source?.acceptedContinuityInstructionIdentity() === continuedDelegationSource.instructionIdentity;
    if (((!candidate || `${namespace}:${candidate}` !== (binding.logicalExecutionKey ?? sourceExecutionKey))
      && !matchesContinuedDelegation) || !source
      || source !== chatGptTurnSessions.findConversationHead(conversationKey)
      || source.supersededError || (binding.state === "compacting" && binding.compactionKey !== executionKey)) {
      if (config.toolAuthorityMode === "delegated" && source && source.taskRevision() === 0) {
        source.cancel(continuityError("continuity_source_unproven"));
        await source.runtime.retireCapability?.();
        bindings.lose(binding, sourceExecutionKey);
      }
      throw continuityError("continuity_source_unproven");
    }
    try {
      source.assertContinuitySourceInstruction(parsed);
    } catch (error) {
      if (config.toolAuthorityMode === "delegated" && source.taskRevision() === 0) {
        const reason = error instanceof Error ? error : continuityError("continuity_source_unproven");
        source.cancel(reason);
        await source.runtime.retireCapability?.();
        bindings.lose(binding, sourceExecutionKey);
      }
      throw error;
    }
    verifiedSourceGeneration = source.continuityGenerationValue();
  }
  if (binding && expected && !existing?.roundCompleted(existing.continuityRoundKey(parsed))) {
    const compactionLossIdentity = parsed._compactionRequest && expected.recovery
      ? { ownerId: binding.owner, identity: structuredClone(expected.recovery) } : undefined;
    try { await inspectLauncherContinuityConversation(descriptor, conversationKey, expected); }
    catch (inspectionError) {
      if (!sameLease(binding.lease, expected)) {
        if (!exactCurrentWork() || !binding.lease) throw continuityError("continuity_source_unproven");
        expected = { ...binding.lease };
        await inspectLauncherContinuityConversation(descriptor, conversationKey, expected);
      } else {
        // The wrapper rechecks the actual page and retries closed/unknown pages
        // through fresh admission. Historical loss receipts do not grant recovery.
        throw inspectionError;
      }
    }

    if ((!sameLease(binding.lease, expected) || binding.executionKey !== sourceExecutionKey) && !exactCurrentWork()) {
      throw continuityError("continuity_source_unproven");
    }
    existing = chatGptTurnSessions.find(executionKey);
  }
  const toolSource = parsed._compactionRequest && binding?.checkpoints.has(executionKey)
    ? undefined : existing ?? (sourceExecutionKey ? chatGptTurnSessions.find(sourceExecutionKey) : undefined);
  parsed.context.tools = continuityToolRegistry(parsed, binding, toolSource).tools;
  let input: CodexParsedRequest | undefined;
  let instructionPrevious: ChatGptContinuityInstructionPrevious | undefined;
  let allowRetainedSourceInstructionPayload = false;
  let finalReplaySource: ChatGptTurnSession | undefined;
  let checkpointTransition: ContinuityCheckpointSelection | undefined;
  let coldPage = false;
  let pendingPageContext = false;
  if (!parsed._compactionRequest && !existing && appendSource) {
    if (!appendSource.hasTaskInputSource()) {
      throw taskUpdateSourceError("task_update_upgrade_required", "This runtime cannot prove durable input receipt for the active response.");
    }
  } else if (!parsed._compactionRequest && !existing) {
    // The first cold request already accepted these results as history. A retry
    // can arrive before its runtime exists, but cannot add or change results.
    const accepted = binding?.state === "creating" && binding.initialExecutionKey === executionKey && !expected
      ? binding.initialAcceptedInput : undefined;
    assertNoUnownedTerminalResults(parsed, checkpointProof.index, accepted);
    chatGptTurnSessions.assertContinuityThreadAvailable(identity.threadId, executionKey);
    if (binding && binding.state !== "ready"
      && !(binding.state === "creating" && binding.initialExecutionKey === executionKey && !expected)) {
      throw continuityError("continuity_source_unproven", `The current page is ${binding.state}.`);
    }
    if (expected && binding?.executionKey === undefined && binding!.revision > 0) {
      ({ input, instructionPrevious, allowRetainedSourceInstructionPayload, finalReplaySource } = checkpointResumeInput(
        parsed,
        binding!,
        selectedCheckpoint,
        checkpointProof,
        recoveredCheckpointNewInstruction(parsed, bindings, binding!, selectedCheckpoint, checkpointProof),
      ));
      if (allowRetainedSourceInstructionPayload) {
        if (!checkpointSelection || checkpointSelection.checkpoint.revision !== revision) {
          throw continuityError("continuity_source_unproven", "The request has no exact committed checkpoint transition.");
        }
        checkpointTransition = checkpointSelection;
      }
    } else if (expected) {
      ({ input, instructionPrevious } = ordinaryResumeInput(parsed, binding!, conversationKey, checkpointProof));
    } else if (binding?.state === "creating" && binding.initialExecutionKey === executionKey
      && binding.initialAcceptedInput && binding.initialInstructionPayloadDigest) {
      if (chatGptContinuityInstructionPayloadDigest(parsed) !== binding.initialInstructionPayloadDigest) {
        throw continuityError("continuity_source_unproven", "The accepted native instruction identity now carries a different current payload.");
      }
      input = continuityAcceptedContextCandidate(parsed, binding.initialAcceptedInput);
      pendingPageContext = true;
    } else input = parsed;
    if (!finalReplaySource && expected) {
      await toolSource?.runtime.syncContextUsage?.();
      const coverage = toolSource?.runtime.compactionSourceCoverage;
      const previousFinal = toolSource?.settledOutcome();
      const retainedTokens = coverage || binding?.retainedPageTokens !== undefined
        ? Math.max(binding?.retainedPageTokens ?? 0, (coverage?.pageTokenReserve() ?? 0)
          + (previousFinal?.type === "final" ? estimateTokens(previousFinal.answer) : 0)) : undefined;
      let retainedFailure = false;
      if (!config.experimentalFreshConversationPerTurn && retainedTokens !== undefined) {
        try { preflightContinuityInput(input, capabilities, config.experimentalSkillAttachments, true,
          { retainedTokens, experimentalBiggerContext: config.experimentalBiggerContext }); }
        catch (error) {
          if (!["CONTEXT_BUDGET_EXCEEDED", "context_length_exceeded", "continuity_input_limit"].includes(String((error as { code?: string }).code))) throw error;
          retainedFailure = true;
        }
      }
      if (config.experimentalFreshConversationPerTurn || retainedTokens === undefined || retainedFailure) {
        input = parsed;
        expected = undefined;
        coldPage = true;
      }
    }
    if (!finalReplaySource) preflightContinuityInput(input, capabilities, config.experimentalSkillAttachments, Boolean(expected),
      { experimentalBiggerContext: config.experimentalBiggerContext });
  } else if (binding?.state === "compacting" && !parsed._compactionRequest
    && !existing?.roundCompleted(existing.continuityRoundKey(parsed))) {
    throw continuityError("continuity_source_unproven");
  }
  if (!binding) {
    await assertLauncherContinuityCapacity(descriptor);
    abortSignal?.throwIfAborted();
    const payloadDigest = chatGptContinuityInstructionPayloadDigest(parsed);
    if (parsed._compactionRequest) throw continuityError("continuity_source_unproven", "A standalone compaction cannot enter continuity.");
    bindings.recoveryStore.admitWork({ thread, scope, owner: continuityProcessInstance(bindings.owner),
      logicalWorkId: recoveryDigest([scope, identity.turnId, continuityInstructionIdentity(parsed), "ordinary", parsed._continuityEpoch ?? 0]),
      instructionIdentity: continuityInstructionIdentity(parsed), nativeTurnId: identity.turnId,
      workPayloadDigest: payloadDigest, snapshotDigest: recoveryDigest(input!.context), createPage: true, dispatchProtocolComplete: true });
    binding = bindings.create(thread, scope, executionKey, checkpoint, identity.turnId);
    if (binding.initialAcceptedInput) {
      if (binding.initialInstructionPayloadDigest !== payloadDigest) {
        throw continuityError("continuity_source_unproven", "The accepted native instruction identity now carries a different current payload.");
      }
      input = continuityAcceptedContextCandidate(parsed, binding.initialAcceptedInput);
    } else {
      binding.initialAcceptedInput = structuredClone(input!);
      binding.initialInstructionPayloadDigest = payloadDigest;
    }
  }
  abortSignal?.throwIfAborted();
  binding.conversation ??= { key: conversationKey, descriptor };
  let recovery: ContinuityRecoveryIdentity | undefined;
  if (!parsed._compactionRequest && input && !finalReplaySource) {
    if (coldPage) {
      await assertLauncherContinuityCapacity(descriptor);
      abortSignal?.throwIfAborted();
      if (!ordinarySourceObservation?.record || bindings.observed(thread) !== binding
        || binding.owner !== ordinarySourceObservation.owner || binding.epoch !== ordinarySourceObservation.epoch
        || binding.revision !== ordinarySourceObservation.revision || binding.executionKey !== ordinarySourceObservation.executionKey
        || continuityDigest(binding.lease ?? null) !== continuityDigest(ordinarySourceObservation.lease ?? null)) {
        throw continuityError("continuity_source_unproven", "The cold-page source observation is stale; inspect the current writer again.");
      }
      await retireRecoveryWriter(bindings, ordinarySourceObservation.record, descriptor, taskInputRequestIdentity(parsed));
    }
    const logicalWorkId = recoveryDigest([scope, identity.turnId, continuityInstructionIdentity(parsed), "ordinary", parsed._continuityEpoch ?? 0]);
    if (instructionPrevious && !instructionPrevious.instructionIdentity) throw continuityError("continuity_source_unproven");
    let record = bindings.recoveryStore.admitWork({ thread, scope, owner: continuityProcessInstance(bindings.owner),
      logicalWorkId, instructionIdentity: continuityInstructionIdentity(parsed), nativeTurnId: identity.turnId,
      workPayloadDigest: chatGptContinuityInstructionPayloadDigest(parsed, instructionPrevious, allowRetainedSourceInstructionPayload),
      instructionPrevious: instructionPrevious ? { ...instructionPrevious, instructionIdentity: instructionPrevious.instructionIdentity! } : undefined,
      allowRetainedSourceFallback: allowRetainedSourceInstructionPayload,
      snapshotDigest: recoveryDigest(input.context), createPage: !expected, dispatchProtocolComplete: true });
    if (record.works[logicalWorkId]?.attempts.at(-1)?.preparationTermination?.status === "settled") {
      record = bindings.recoveryStore.retryTerminatedPreparation(thread, { scope, expectedVersion: record.version }, logicalWorkId, recoveryDigest(input.context));
    }
    if (coldPage) {
      parsed._continuityEpoch = record.epoch;
      parsed._continuityAttempt = record.works[logicalWorkId]!.attempts.at(-1)!.attempt;
      input._continuityEpoch = record.epoch;
      input._continuityAttempt = parsed._continuityAttempt;
      conversationKey = chatGptConversationKey(parsed, namespace)!;
      binding = bindings.installRecovered(record, executionKey, checkpoint, identity.turnId);
      binding.initialAcceptedInput = continuityAcceptedContextCandidate(parsed, input);
      binding.initialInstructionPayloadDigest = record.works[logicalWorkId]!.workPayloadDigest;
      binding.conversation = { key: conversationKey, descriptor };
    }
    binding.recovery = { directory: bindings.registrations.directory, thread, logicalWorkId, attempt: record.works[logicalWorkId]!.attempts.at(-1)!.attempt, ownerId: record.owner.id };
    recovery = recoveryIdentity(record, bindings.recoveryStore.installationId());
  }
  return {
    bindings, binding, descriptor, conversationKey, executionKey, nativeThreadId: identity.threadId,
    revision, sourceExecutionKey, expected, input, instructionPrevious,
    allowRetainedSourceInstructionPayload, finalReplaySource, verifiedSourceGeneration,
    checkpointTransition,
    appendSource, recovery,
    ...(pendingPageContext ? { recovered: true } : {}),
  };
}

/** The synchronous start boundary rechecks every preflight observation after asynchronous work. */
export function beginContinuityResponse(prepared: PreparedContinuityRequest): ContinuityClaim {
  const { binding, bindings } = prepared;
  if (!prepared.input || bindings.lookup(binding.thread, binding.scope) !== binding
    || binding.revision !== prepared.revision || !sameLease(binding.lease, prepared.expected)
    || (prepared.expected && binding.executionKey !== prepared.sourceExecutionKey)) {
    throw continuityError("continuity_source_unproven");
  }
  chatGptTurnSessions.assertContinuityThreadAvailable(prepared.nativeThreadId, prepared.executionKey);
  const transition = prepared.checkpointTransition;
  if (transition && (transition.binding !== binding || binding.checkpoints.get(transition.key) !== transition.checkpoint
    || transition.checkpoint.revision !== prepared.revision
    || (transition.checkpoint.continuationExecutionKey !== undefined
      && transition.checkpoint.continuationExecutionKey !== prepared.executionKey))) {
    throw continuityError("continuity_source_unproven", "The checkpoint transition was already consumed by another execution.");
  }
  const claim = bindings.beginResponse(binding, prepared.executionKey);
  if (prepared.recovery) claim.recovery = prepared.recovery;
  if (transition) transition.checkpoint.continuationExecutionKey = prepared.executionKey;
  return claim;
}

export function acceptContinuityResponseLease(prepared: PreparedContinuityRequest, traceId: string, value: unknown): ContinuityLease {
  if (!isContinuityLease(value) || value.traceId !== traceId || prepared.binding.executionKey !== prepared.executionKey) {
    throw continuityError("continuity_session_lost");
  }
  if (prepared.recovery && (!value.recovery || recoveryDigest(value.recovery) !== recoveryDigest(prepared.recovery))) throw continuityError("continuity_source_unproven", "The page receipt belongs to an obsolete recovery snapshot.");
  if (prepared.binding.recovery) {
    const ref = prepared.binding.recovery;
    const record = prepared.bindings.recoveryStore.get(ref.thread)!;
    const attempt = record.works[ref.logicalWorkId]!.attempts[ref.attempt]!;
    if (attempt.pageReceiptId && attempt.pageReceiptId !== value.leaseId) throw continuityError("continuity_source_unproven", "The page receipt conflicts with its physical document.");
    if (["prepared", "page-possible", "page-acquired", "send-possible", "accepted"].includes(attempt.stage)) {
      // Zero Risk can record Send before its page acknowledgement arrives. Persist
      // the physical receipt without moving that writer's execution stage backwards.
      const stage = ["send-possible", "accepted"].includes(attempt.stage) ? attempt.stage : "page-acquired";
      prepared.bindings.recoveryStore.markAttempt(ref.thread, { scope: record.scope }, {
        logicalWorkId: ref.logicalWorkId, attempt: ref.attempt, stage, pageReceiptId: value.leaseId,
        transactionVersion: prepared.recovery?.transactionVersion });
    }
  }
  prepared.bindings.acceptLease(prepared.binding, value);
  prepared.binding.pendingCreation?.();
  prepared.releaseAdmission?.();
  return { ...value };
}

export async function finishContinuityResponse(prepared: PreparedContinuityRequest): Promise<void> {
  const { binding, bindings } = prepared;
  if (!binding.lease || binding.executionKey !== prepared.executionKey) throw continuityError("continuity_session_lost");
  const physical = await inspectLauncherContinuityConversation(prepared.descriptor, prepared.conversationKey, binding.lease);
  if (physical.state !== "ready") throw continuityError("continuity_unverified");
  if (binding.state === "unverified") binding.state = "running";
  bindings.responseReady(binding, prepared.executionKey);
}

/** Durable receipts win before any page inspection. Only the current request supplies context. */
async function prepareExplicitTaskInputRetry(
  parsed: CodexParsedRequest, namespace: string, capabilities: ChatGptWebCapabilities, attachments: boolean | undefined,
  bindings: ContinuityBindings, observed: RecoveryThreadRecord, retry: RecoveryTaskInputRetry, descriptor: string,
  compatible: () => Promise<void>, abortSignal?: AbortSignal, experimentalBiggerContext = false,
): Promise<PreparedContinuityRequest> {
  const native = extractChatGptTurnIdentity(parsed), store = bindings.recoveryStore;
  const metadata = { identity: { thread: observed.thread, scope: observed.scope, taskId: retry.taskId },
    intentGeneration: retry.intentGeneration, messageIds: [...retry.messageIds] };
  const logicalWorkId = recoveryDigest([observed.scope, native.turnId, "explicit-input-retry", retry.taskId, retry.intentGeneration]);
  const existing = observed.works[logicalWorkId];
  if (existing) {
    if (observed.currentWorkId !== logicalWorkId || existing.state === "stopped"
      || canonicalJson(existing.taskInputRetry) !== canonicalJson(retry)) throw continuityError("continuity_stopped");
    if (existing.workPayloadDigest !== chatGptContinuityInstructionPayloadDigest(parsed)) throw continuityError("continuity_source_unproven");
    parsed._continuityAttempt = existing.attempts.at(-1)!.attempt;
    parsed._continuityPageGeneration = existing.attempts[0]!.epoch;
    parsed._continuityEpoch = existing.attempts.at(-1)!.epoch;
    parsed._continuityHistoryRevision = existing.attempts.at(-1)!.historyRevision;
    const binding = bindings.observed(observed.thread);
    const executionKey = `${namespace}:${chatGptTurnExecutionKey(parsed)}`;
    if (binding && binding.executionKey === executionKey && !["lost", "ended", "unverified"].includes(binding.state)
      && observed.owner.id === bindings.owner) return { bindings, binding, descriptor,
      conversationKey: binding.conversation!.key, executionKey, nativeThreadId: native.threadId!,
      revision: observed.historyRevision, taskInputRetry: metadata };
    const recovered = await prepareDurableOrdinary(parsed, namespace, capabilities, attachments, bindings, observed,
      descriptor, abortSignal, compatible, experimentalBiggerContext);
    if (!recovered) throw continuityError("continuity_unverified");
    return { ...recovered, taskInputRetry: metadata };
  }
  const source = retry.sourceLogicalWorkId ? observed.works[retry.sourceLogicalWorkId] : undefined;
  if (!source || observed.currentWorkId !== source.logicalWorkId || source.state !== "stopped" || source.nativeTurnId !== native.turnId
    || source.purpose !== "ordinary") throw continuityError("continuity_source_unproven");
  if (source.attempts.some(attempt => attempt.sendEvidence?.status === "possible")) throw continuityError("continuity_execution_unsettled", "The previous Send remains unverified.");
  // Reading the saved bodies verifies custody. Current trusted client bytes still
  // supply the instruction and current permissions; inbox content grants neither.
  const inbox = new ContinuityTaskInputStore(bindings.registrations.directory);
  for (const [index, id] of retry.messageIds.entries()) {
    if (taskUpdateDigest(inbox.readBody(metadata.identity, id)) !== retry.messageDigests[index]) throw continuityError("continuity_context_missing");
  }
  await compatible();
  const input = recoveryContext(parsed, { directory: bindings.registrations.directory, thread: observed.thread,
    logicalWorkId: source.logicalWorkId, attempt: source.attempts.at(-1)!.attempt });
  continuityRecoveredContextCandidate(parsed, input);
  assertRecoveredSource(parsed, input, store.get(observed.thread)!, source, source.attempts.at(-1)!.historyRevision);
  preflightContinuityInput(input, capabilities, attachments, false, { experimentalBiggerContext });
  await assertLauncherContinuityCapacity(descriptor);
  abortSignal?.throwIfAborted();
  const current = store.get(observed.thread)!;
  if (current.currentWorkId !== observed.currentWorkId || current.epoch !== observed.epoch || current.owner.id !== observed.owner.id) {
    throw continuityError("continuity_unverified");
  }
  const retired = await retireRecoveryWriter(bindings, current, descriptor, taskInputRequestIdentity(parsed));
  abortSignal?.throwIfAborted();
  const payload = chatGptContinuityInstructionPayloadDigest(parsed);
  const admitted = store.reserveTaskInputRetry({ thread: retired.thread, scope: retired.scope,
    owner: continuityProcessInstance(bindings.owner), logicalWorkId, instructionIdentity: continuityInstructionIdentity(parsed),
    nativeTurnId: native.turnId, workPayloadDigest: payload, snapshotDigest: recoveryDigest(input.context),
    createPage: true, dispatchProtocolComplete: true }, retry, retired.version);
  parsed._continuityAttempt = 0; parsed._continuityEpoch = admitted.epoch; parsed._continuityHistoryRevision = admitted.historyRevision;
  parsed._continuityPageGeneration = input._continuityPageGeneration = admitted.epoch;
  input._continuityAttempt = 0; input._continuityEpoch = admitted.epoch; input._continuityHistoryRevision = admitted.historyRevision;
  const canonical = contextCandidateCanonicalSource(parsed, input)!;
  canonical._continuityAttempt = 0; canonical._continuityEpoch = admitted.epoch; canonical._continuityHistoryRevision = admitted.historyRevision;
  canonical._continuityPageGeneration = admitted.epoch;
  const executionKey = `${namespace}:${chatGptTurnExecutionKey(parsed)}`;
  const binding = bindings.installRecovered(admitted, executionKey, continuityCheckpoint(parsed).digest, native.turnId);
  binding.initialAcceptedInput = continuityAcceptedContextCandidate(parsed, input); binding.initialInstructionPayloadDigest = payload;
  const conversationKey = chatGptConversationKey(parsed, namespace)!;
  binding.conversation = { key: conversationKey, descriptor };
  return { bindings, binding, descriptor, conversationKey, executionKey, nativeThreadId: native.threadId!,
    revision: admitted.historyRevision, input, recovery: recoveryIdentity(admitted, store.installationId()), recovered: true,
    taskInputRetry: metadata };
}

async function prepareDurableOrdinary(
  parsed: CodexParsedRequest, namespace: string, capabilities: ChatGptWebCapabilities,
  attachments: boolean | undefined, bindings: ContinuityBindings, observed: RecoveryThreadRecord,
  descriptor: string, abortSignal?: AbortSignal, assertExecutionCompatible?: () => Promise<void>,
  experimentalBiggerContext = false,
): Promise<PreparedContinuityRequest | undefined> {
  const identity = extractChatGptTurnIdentity(parsed);
  const liveBinding = bindings.observed(observed.thread);
  const instruction = continuityInstructionIdentity(parsed);
  const store = bindings.recoveryStore;
  const currentWork = observed.currentWorkId ? observed.works[observed.currentWorkId] : undefined;
  const logicalWorkId = currentWork?.taskInputRetry && currentWork.instructionIdentity === instruction && currentWork.nativeTurnId === identity.turnId
    ? currentWork.logicalWorkId : recoveryDigest([observed.scope, identity.turnId, instruction, "ordinary", observed.epoch]);
  let record = observed;
  let work = record.works[logicalWorkId];
  const binding = bindings.observed(record.thread);
  if (work && work.state === "stopped") throw continuityError("continuity_stopped");
  if (liveBinding && !["lost", "ended", "unverified"].includes(liveBinding.state) && observed.owner.id === bindings.owner) return undefined;
  const payload = chatGptContinuityInstructionPayloadDigest(parsed, work?.instructionPrevious, work?.allowRetainedSourceFallback);
  if (work && work.workPayloadDigest !== payload) throw continuityError("continuity_source_unproven", "The accepted instruction has a different current payload.");
  if (work) {
    parsed._continuityAttempt = work.attempts.at(-1)!.attempt;
    parsed._continuityEpoch = work.attempts.at(-1)!.epoch;
    parsed._continuityHistoryRevision = work.attempts.at(-1)!.historyRevision;
  }
  const existingKey = work ? `${namespace}:${chatGptTurnExecutionKey(parsed)}` : undefined;
  const existing = existingKey ? chatGptTurnSessions.find(existingKey) : undefined;
  if (work?.state === "completed") {
    // The durable receipt can precede local publication while page cleanup finishes.
    const outcome = existing ? existing.settledOutcome() ?? await existing.browserOutcome : undefined;
    abortSignal?.throwIfAborted();
    if (!existing || outcome?.type !== "final" || !binding || !work.terminalReceiptId
      || work.terminalDigest !== recoveryDigest(outcome.answer)) throw continuityError("continuity_replay_unavailable");
    existing.assertCanonicalReplayInput(parsed);
    return { bindings, binding, descriptor, conversationKey: binding.conversation?.key ?? chatGptConversationKey(parsed, namespace)!,
      executionKey: existingKey!, nativeThreadId: identity.threadId!, revision: parsed._continuityHistoryRevision! };
  }
  await assertExecutionCompatible?.();
  if (binding?.state === "unverified" && binding.lease && binding.conversation) {
    const inspectedLease = { ...binding.lease };
    try {
      const physical = await inspectLauncherContinuityConversation(descriptor, binding.conversation.key, inspectedLease);
      binding.state = physical.state === "ready" ? "ready" : "running";
    } catch (error) {
      if (!sameLease(binding.lease, inspectedLease)) throw continuityError("continuity_source_unproven");
      // A repeated inspection failure only disproves reuse. The durable Send,
      // settlement and execution-isolation checks below decide cold recovery.
      bindings.lose(binding, binding.executionKey);
    }
  }
  if (binding && !["lost", "ended"].includes(binding.state) && record.owner.id === bindings.owner) return undefined;
  if (work && store.get(record.thread)!.works[logicalWorkId]?.attempts.at(-1)?.stage === "send-possible") {
    throw continuityError("continuity_execution_unsettled", "The original Send has no verified submission result.");
  }
  // Historical discovery cannot define new capabilities while rebuilding a lost page.
  parsed.context.tools = continuityToolRegistry(parsed, binding, existing).tools;
  // Preflight precedes every new page. The old call set remains authoritative even when
  // this request is a new instruction after an explicit stop.
  let input = parsed;
  const previous = work ?? (record.currentWorkId ? record.works[record.currentWorkId] : undefined);
  if (!previous) throw continuityError("continuity_context_missing");
  const ref: RuntimeRecoveryReference = { directory: bindings.registrations.directory, thread: record.thread,
    logicalWorkId: previous.logicalWorkId, attempt: previous.attempts.at(-1)!.attempt };
  const checkpointProof = continuityCheckpoint(parsed);
  const checkpoints = checkpointProof.index < 0 ? [] : Object.values(record.checkpoints).filter(checkpoint =>
    checkpoint.summaryDigest === checkpointProof.digest && checkpoint.workLineageId === previous.workLineageId
    && checkpoint.targetHistoryRevision === previous.attempts.at(-1)!.historyRevision);
  if (checkpoints.length > 1) throw continuityError("continuity_source_unproven", "The recovery input cannot distinguish its accepted checkpoint.");
  const recoveryCheckpoint = checkpoints[0];
  let recoveredInput: CodexParsedRequest | undefined;
  const recoverySource = existing ?? (binding?.executionKey ? chatGptTurnSessions.find(binding.executionKey) : undefined);
  if (work || previous.state !== "completed") input = recoveredInput = recoveryContext(parsed, ref, recoveryCheckpoint?.commitId);
  if (work && binding?.initialAcceptedInput && ["prepared", "page-possible", "page-acquired"].includes(work.attempts.at(-1)!.stage)) {
    input = continuityAcceptedContextCandidate(parsed, binding.initialAcceptedInput);
  }
  if (input === recoveredInput) {
    continuityRecoveredContextCandidate(parsed, input, recoverySource?.restoreCompactionIssuedCalls(
      (input._rawBody as { input: unknown[] }).input), recoverySource?.canonicalInput(),
      recoverySource?.compactionObjectArgumentCallIds());
  }
  if (work) assertRecoveredSource(parsed, input, store.get(record.thread)!, work, work.attempts.at(-1)!.historyRevision);
  preflightContinuityInput(input, capabilities, attachments, false, { experimentalBiggerContext });
  await assertLauncherContinuityCapacity(descriptor);
  abortSignal?.throwIfAborted();
  const current = store.get(record.thread)!;
  if (current.currentWorkId !== record.currentWorkId || recoveryDigest(current.transaction) !== recoveryDigest(record.transaction)
    || recoveryDigest(current.pendingPreparation ?? null) !== recoveryDigest(record.pendingPreparation ?? null)) throw continuityError("continuity_unverified");
  record = current;
  // A pending CAS retains both identities until the Launcher has confirmed the
  // exact migration. A later backend must finish it before proposing its own input.
  if (record.pendingPreparation) {
    const pending = record.pendingPreparation;
    const preparationStopped = record.works[pending.expected.transaction.logicalWorkId]!.state === "stopped";
    if (!preparationStopped && pending.target.owner.id !== bindings.owner
      && continuityProcessInstanceStatus(pending.target.owner) !== "exited") throw continuityError("continuity_unverified");
    const expected = recoveryIdentity({ ...record, ...pending.expected }, store.installationId());
    const target = recoveryIdentity({ ...record, ...pending.target }, store.installationId());
    if (preparationStopped) {
      // Stop fences the old Broker. Retire the exact physical tag that the host
      // retained, then preserve both tags as a retirement receipt for a new task.
      let receipt;
      try { receipt = await retireLauncherContinuityWriter(descriptor, target, bindings.registrations.directory); }
      catch { receipt = await retireLauncherContinuityWriter(descriptor, expected, bindings.registrations.directory); }
      if (!receipt.writerRetired) throw continuityError("continuity_unverified");
      record = store.retirePreparation(record.thread, { scope: record.scope, expectedVersion: record.version }, pending.preparationId);
    } else {
      let missing = false;
      try {
        const receipt = await updateLauncherContinuityPreparation(descriptor, { expected, recovery: target }, bindings.registrations.directory);
        if (receipt.state !== "prepared") throw continuityError("continuity_execution_unsettled");
      } catch (error) {
        // A host restart may erase both tags, but an absent table alone is not a
        // retirement proof. This branch can only close the unsent migration after
        // the original Broker process and the original Launcher are proved gone.
        const receipt = await queryLauncherContinuityTransaction(descriptor, target, bindings.registrations.directory).catch(() => undefined);
        if (!receipt || !["missing", "retired"].includes(receipt.state) || !receipt.writerRetired
          || (receipt.state === "missing" && !receipt.hostNoWriter)
          || continuityProcessInstanceStatus(pending.expected.owner) !== "exited") {
          if ((error as { code?: string }).code === "continuity_execution_unsettled") throw error;
          throw continuityError("continuity_unverified", "The pending input preparation has no exact applied or retired receipt yet.");
        }
        missing = true;
      }
      record = store.completePreparation(record.thread, { scope: record.scope, expectedVersion: record.version }, pending.preparationId);
      if (missing) record = store.retireAttempt(record.thread, { scope: record.scope, expectedVersion: record.version },
        pending.target.transaction.logicalWorkId, pending.target.transaction.attempt);
    }
    work = record.works[logicalWorkId];
  }
  const attemptBefore = work?.attempts.at(-1);
  const acquisition = attemptBefore?.acquisitionEvidence;
  const knownUnacquired = work && record.currentWorkId === logicalWorkId && record.owner.id === bindings.owner
    && attemptBefore?.stage === "prepared" && !attemptBefore.writerRetired
    && acquisition?.status === "not-acquired" && Boolean(acquisition.receiptId);
  if (knownUnacquired && (acquisition!.identityDigest !== recoveryDigest(canonicalJson(recoveryIdentity(record, store.installationId())))
    || attemptBefore!.snapshotDigest !== recoveryDigest(input.context))) {
    throw continuityError("continuity_source_unproven", "The known unacquired retry no longer matches its original input and reservation.");
  }
  const unsentCandidate = work && attemptBefore && ["prepared", "page-possible", "page-acquired"].includes(attemptBefore.stage)
    && work.retryBudget?.lastFailureAt === undefined
    && !binding?.initialAcceptedInput
    && (record.owner.id === bindings.owner || continuityProcessInstanceStatus(record.owner) === "exited");
  let sameAttempt = Boolean(knownUnacquired);
  if (!sameAttempt && unsentCandidate) {
    const previousIdentity = recoveryIdentity(record, store.installationId());
    const receipt = await queryLauncherContinuityTransaction(descriptor, previousIdentity, bindings.registrations.directory);
    // Creating is still the original acquisition. Keep its sole queryable identity
    // and wait for a prepared receipt; do not create a migration or another page.
    if (receipt.state === "creating") throw continuityError("continuity_unverified", "The original page acquisition is still in progress.");
    if (!["missing", "prepared", "retired"].includes(receipt.state)) throw continuityError("continuity_execution_unsettled");
    // A backend can exit after persisting acquisition authority but before its
    // first RPC reaches this exact live host. No Send was authorized. Missing
    // alone does not revoke that authority: fall through to durable retirement
    // and exact host isolation before reserving a successor; never reuse it.
    const exitedBeforeAcquisition = receipt.state === "missing" && receipt.hostNoWriter
      && attemptBefore.stage === "page-possible" && !attemptBefore.sendEvidence && !attemptBefore.pageReceiptId
      && acquisition?.status === "possible"
      && acquisition.identityDigest === recoveryDigest(canonicalJson(previousIdentity))
      && sameContinuityLauncherInstance(attemptBefore.launcherInstance, receipt.launcherInstance)
      && continuityProcessInstanceStatus(record.owner) === "exited";
    if (receipt.state === "missing" && (!receipt.hostNoWriter
      || (attemptBefore.launcherInstance ? !receipt.writerRetired && !exitedBeforeAcquisition : attemptBefore.stage !== "prepared"))) throw continuityError("continuity_unverified");
    if (receipt.state === "prepared") {
      if (!receipt.launcherInstance) throw continuityError("continuity_unverified");
      if (record.owner.id !== bindings.owner || record.transaction!.snapshotDigest !== recoveryDigest(input.context)) {
        record = store.beginPreparation(record.thread, { scope: record.scope, expectedVersion: record.version }, {
          logicalWorkId, owner: continuityProcessInstance(bindings.owner), snapshotDigest: recoveryDigest(input.context),
          launcherInstance: receipt.launcherInstance,
        });
        const pending = record.pendingPreparation!;
        const prepared = await updateLauncherContinuityPreparation(descriptor, { expected: previousIdentity,
          recovery: recoveryIdentity({ ...record, ...pending.target }, store.installationId()) }, bindings.registrations.directory);
        if (prepared.state !== "prepared") throw continuityError("continuity_execution_unsettled");
        record = store.completePreparation(record.thread, { scope: record.scope, expectedVersion: record.version }, pending.preparationId);
      }
      sameAttempt = true;
    } else if (receipt.state === "missing" && attemptBefore.stage === "prepared" && !attemptBefore.launcherInstance) {
      // No acquisition was authorized at all. This is the only empty-table case
      // that can reuse the initial budget without an actual prepared page receipt.
      record = store.transact(record.thread, { scope: record.scope, expectedVersion: record.version }, draft => { draft.owner = continuityProcessInstance(bindings.owner); });
      record = store.rebindSnapshot(record.thread, { scope: record.scope, expectedVersion: record.version }, logicalWorkId, recoveryDigest(input.context));
      sameAttempt = true;
    }
  }
  if (!sameAttempt) record = await retireRecoveryWriter(bindings, record, descriptor, taskInputRequestIdentity(parsed));
  abortSignal?.throwIfAborted();
  if (work && !sameAttempt) {
    record = store.reserveRecovery(record.thread, { scope: record.scope, expectedVersion: record.version }, {
      logicalWorkId, owner: continuityProcessInstance(bindings.owner), snapshotDigest: recoveryDigest(input.context),
    });
  } else if (!work) {
    if (!hasInitialChatGptTurnInstruction(parsed)) throw continuityError("continuity_context_missing");
    record = store.admitWork({ thread: record.thread, scope: record.scope, owner: continuityProcessInstance(bindings.owner),
      logicalWorkId, instructionIdentity: instruction, nativeTurnId: identity.turnId, workPayloadDigest: payload,
      snapshotDigest: recoveryDigest(input.context), createPage: true, dispatchProtocolComplete: true });
  }
  work = record.works[logicalWorkId]!;
  parsed._continuityAttempt = work.attempts.at(-1)!.attempt;
  parsed._continuityEpoch = record.epoch;
  parsed._continuityHistoryRevision = record.historyRevision;
  input._continuityAttempt = parsed._continuityAttempt;
  input._continuityEpoch = record.epoch;
  input._continuityHistoryRevision = record.historyRevision;
  if (input === recoveredInput) {
    const source = contextCandidateCanonicalSource(parsed, input)!;
    source._continuityAttempt = input._continuityAttempt;
    source._continuityEpoch = input._continuityEpoch;
    source._continuityHistoryRevision = input._continuityHistoryRevision;
  }
  const executionKey = `${namespace}:${chatGptTurnExecutionKey(parsed)}`;
  const checkpoint = continuityCheckpoint(parsed);
  const restored = bindings.installRecovered(record, executionKey, checkpoint.digest, identity.turnId);
  restored.initialAcceptedInput = continuityAcceptedContextCandidate(parsed, input);
  restored.initialInstructionPayloadDigest = payload;
  const conversationKey = chatGptConversationKey(parsed, namespace)!;
  restored.conversation = { key: conversationKey, descriptor };
  return { bindings, binding: restored, descriptor, conversationKey, executionKey, nativeThreadId: identity.threadId!,
    revision: record.historyRevision, input, recovery: recoveryIdentity(record, store.installationId()), recovered: true,
    recoveryCheckpointId: recoveryCheckpoint?.workLineageId === work.workLineageId ? recoveryCheckpoint.commitId : undefined,
    instructionPrevious: work.instructionPrevious, allowRetainedSourceInstructionPayload: work.allowRetainedSourceFallback };
}

async function prepareDurableContinuation(
  parsed: CodexParsedRequest, namespace: string, capabilities: ChatGptWebCapabilities,
  attachments: boolean | undefined, bindings: ContinuityBindings, observed: RecoveryThreadRecord,
  descriptor: string, abortSignal?: AbortSignal, assertExecutionCompatible?: () => Promise<void>, freshConversationPerTurn = false,
  experimentalBiggerContext = false,
): Promise<PreparedContinuityRequest | undefined> {
  const proof = continuityCheckpoint(parsed);
  if (proof.index < 0) return undefined;
  const identity = extractChatGptTurnIdentity(parsed);
  const selection = selectRecoveryContinuation(parsed, observed, identity);
  if (!selection) return undefined;
  const { checkpoint } = selection;
  let record = observed;
  let binding = bindings.observed(record.thread);
  const store = bindings.recoveryStore;
  const work = selection.work;
  parsed._continuityHistoryRevision = record.historyRevision;
  parsed._continuityEpoch = record.epoch;
  const localCheckpoint = [...binding?.checkpoints.values() ?? []].find(value => value.revision === checkpoint.targetHistoryRevision);
  const source = observed.works[checkpoint.sourceLogicalWorkId]!;
  if (source.nativeTurnId !== identity.turnId && hasNativeChatGptInstruction(parsed,
    continuityCurrentInstructionInput(parsed, { trustedLowerBound: proof.index }))) return undefined;
  const raw = (parsed._rawBody as { input: unknown[] }).input;
  const primaryIndices = recoveryContinuationPrimaryIndices(parsed, checkpoint, source);
  if (primaryIndices.length > 1) return undefined; // Existing source-echo/new-instruction routing owns this layout.
  const sourceIndex = primaryIndices[0] ?? chatGptCurrentInstructionIndex(parsed);
  for (const value of raw) {
    const sibling = continuityCheckpointSiblingProof(parsed, value);
    if (sibling?.identity && checkpoint.representationDigests.includes(sibling.identity)
      && !checkpoint.representationDigests.includes(sibling.representation)) {
      throw continuityError("continuity_source_unproven", "The checkpoint sibling conflicts with its accepted source.");
    }
  }
  const siblings = continuityCheckpointSiblings(parsed, source.instructionPrevious, sourceIndex);
  const acceptedSiblings = siblings.filter(sibling => checkpoint.representationDigests.includes(sibling.representation));
  const newInstructions = siblings.filter(sibling => !checkpoint.representationDigests.includes(sibling.representation)
    && hasNativeChatGptInstruction(parsed, [sibling.value]));
  // Older single-instruction checkpoints have no sibling proof. An exact primary
  // can still use their original source proof; they cannot authenticate siblings.
  const requiresGroup = siblings.length || (primaryIndices.length && checkpoint.representationDigests.includes(CONTINUITY_CHECKPOINT_SIBLING_PROOF));
  if (requiresGroup && (!checkpoint.representationDigests.includes(continuityCheckpointSiblingGroup(acceptedSiblings))
    || newInstructions.some(sibling => sibling.index < (acceptedSiblings.at(-1)?.index ?? -1)))) {
    throw continuityError("continuity_source_unproven", "The checkpoint sibling group differs from its accepted source.");
  }
  if (newInstructions.length) {
    return undefined;
  }
  if (primaryIndices.length) bindContinuityCheckpointSourceIndex(parsed, sourceIndex);
  // Only the selected checkpoint proves the prefix belongs to this source. The
  // marker can precede that prefix, while native text summaries follow it.
  const suffix = continuityCurrentInstructionInput(parsed, { nativeTurnId: work.nativeTurnId,
    trustedLowerBound: Math.max(proof.index, chatGptCurrentInstructionIndex(parsed)) });
  if (hasNativeChatGptInstruction(parsed, suffix)) return undefined;
  assertCheckpointSourceReplay(parsed, identity, localCheckpoint);
  if (selection.action === "stopped") throw continuityError("continuity_stopped");
  if (selection.action === "replay") {
    parsed._continuityHistoryRevision = record.historyRevision;
    parsed._continuityEpoch = record.epoch;
    parsed._continuityAttempt = work.attempts.at(-1)!.attempt;
    const activeKey = `${namespace}:${chatGptTurnExecutionKey(parsed)}`;
    const active = chatGptTurnSessions.find(activeKey);
    if (active?.isActive() && binding?.recovery?.logicalWorkId === work.logicalWorkId
      && binding.executionKey === activeKey) {
      active.assertCanonicalReplayInput(parsed);
      return { bindings, binding, descriptor, executionKey: activeKey, nativeThreadId: identity.threadId!,
        conversationKey: binding.conversation!.key, revision: record.historyRevision,
        allowRetainedSourceInstructionPayload: true, instructionPrevious: work.instructionPrevious };
    }
    const source = work.terminalReceiptId && work.terminalDigest ? chatGptTurnSessions.findRecoveryFinal(bindings.registrations.directory,
      record.thread, work.workLineageId, work.terminalReceiptId, work.terminalDigest) : undefined;
    if (!source || !binding) throw continuityError("continuity_replay_unavailable");
    if (checkpoint.continuation.state === "consumed") source.assertCanonicalReplayInput(parsed);
    return { bindings, binding, descriptor, executionKey: binding.executionKey ?? "replay", nativeThreadId: identity.threadId!,
      conversationKey: binding.conversation?.key ?? "replay", revision: record.historyRevision, durableFinalReplay: source };
  }
  await assertExecutionCompatible?.();
  if (selection.action === "admit" && checkpoint.targetHistoryRevision !== record.historyRevision) {
    throw continuityError("continuity_source_unproven", "An older checkpoint cannot allocate a continuation at the current history revision.");
  }
  const consumerLogicalWorkId = selection.consumerLogicalWorkId ?? recoveryDigest([record.scope, work.nativeTurnId, work.instructionIdentity, "continuation", checkpoint.commitId]);
  parsed._continuityHistoryRevision = selection.action === "resume" ? work.attempts.at(-1)!.historyRevision : checkpoint.targetHistoryRevision;
  parsed._continuityEpoch = record.epoch;
  parsed._continuityAttempt = selection.action === "resume" ? work.attempts.at(-1)!.attempt : 0;
  let executionKey = `${namespace}:${chatGptTurnExecutionKey(parsed)}`;
  const existing = chatGptTurnSessions.find(executionKey);
  if (selection.action === "resume" && existing?.isActive() && binding && !["lost", "ended"].includes(binding.state)) {
    existing.assertCanonicalReplayInput(parsed);
    return { bindings, binding, descriptor, executionKey, nativeThreadId: identity.threadId!,
      conversationKey: binding.conversation!.key, revision: parsed._continuityHistoryRevision!,
      allowRetainedSourceInstructionPayload: true,
      instructionPrevious: work.instructionPrevious ?? { instructionIdentity: work.instructionIdentity, nativeTurnId: work.nativeTurnId, checkpointDigest: checkpoint.summaryDigest } };
  }
  const beforeRecovery = store.get(record.thread)!;
  if (beforeRecovery.version !== record.version) {
    return prepareDurableContinuation(parsed, namespace, capabilities, attachments, bindings, beforeRecovery, descriptor, abortSignal, assertExecutionCompatible, freshConversationPerTurn, experimentalBiggerContext);
  }
  let input = recoveryContext(parsed, { directory: bindings.registrations.directory, thread: record.thread,
    logicalWorkId: work.logicalWorkId, attempt: work.attempts.at(-1)!.attempt }, checkpoint.commitId);
  const recoveredInput = input;
  const recoverySource = existing ?? (binding?.executionKey ? chatGptTurnSessions.find(binding.executionKey) : undefined);
  // recoveryContext can accept a first real result synchronously. Observe that write
  // before waiting on the page; later version changes still require reconciliation.
  record = store.get(record.thread)!;
  const wasUnverified = binding?.state === "unverified";
  let expected = !freshConversationPerTurn && selection.action === "admit" && binding
    && ["ready", "unverified"].includes(binding.state) ? binding.lease : undefined;
  if (expected && binding?.conversation) {
    try { await inspectLauncherContinuityConversation(descriptor, binding.conversation.key, expected); }
    catch (error) {
      if ((error as { code?: string }).code === "continuity_unverified" && !wasUnverified) {
        binding.state = "unverified";
        throw error;
      }
      expected = undefined;
    }
  }
  // Another observer can consume or finish this exact transition while the page
  // inspection is in flight. Reconcile that receipt before retiring any writer.
  const afterInspection = store.get(record.thread)!;
  if (afterInspection.version !== record.version) {
    return prepareDurableContinuation(parsed, namespace, capabilities, attachments, bindings, afterInspection, descriptor, abortSignal, assertExecutionCompatible, freshConversationPerTurn, experimentalBiggerContext);
  }
  if (expected && binding && localCheckpoint) input = checkpointResumeInput(parsed, binding, localCheckpoint, proof, { suffix,
    instructionPrevious: { instructionIdentity: work.instructionIdentity, nativeTurnId: work.nativeTurnId } }).input;
  const retainedTokens = binding?.retainedPageTokens;
  if (expected) {
    let retainedFailure = retainedTokens === undefined;
    if (!retainedFailure) {
      try { preflightContinuityInput(input, capabilities, attachments, true, { experimentalBiggerContext, retainedTokens }); }
      catch (error) {
        if (!["CONTEXT_BUDGET_EXCEEDED", "context_length_exceeded", "continuity_input_limit"].includes(String((error as { code?: string }).code))) throw error;
        retainedFailure = true;
      }
    }
    if (retainedFailure) { expected = undefined; input = recoveredInput; }
  }
  parsed.context.tools = continuityToolRegistry(parsed, binding, existing).tools;
  input.context.tools = parsed.context.tools;
  if (input === recoveredInput) {
    continuityRecoveredContextCandidate(parsed, input, recoverySource?.restoreCompactionIssuedCalls(
      (input._rawBody as { input: unknown[] }).input), recoverySource?.canonicalInput(),
      recoverySource?.compactionObjectArgumentCallIds());
  }
  if (!expected) assertRecoveredSource(parsed, input, store.get(record.thread)!, work, parsed._continuityHistoryRevision!);
  preflightContinuityInput(input, capabilities, attachments, Boolean(expected), { experimentalBiggerContext });
  if (!expected) {
    await assertLauncherContinuityCapacity(descriptor);
    record = await retireRecoveryWriter(bindings, record, descriptor, taskInputRequestIdentity(parsed));
  }
  abortSignal?.throwIfAborted();
  if (selection.action === "admit") {
    const current = store.get(record.thread)!;
    if (current.version !== record.version) {
      const currentCheckpoint = current.checkpoints[checkpoint.commitId];
      if (currentCheckpoint?.continuation.state === "consumed"
        && currentCheckpoint.continuation.consumerLogicalWorkId === consumerLogicalWorkId) {
        return prepareDurableContinuation(parsed, namespace, capabilities, attachments, bindings, current, descriptor, abortSignal, assertExecutionCompatible, freshConversationPerTurn, experimentalBiggerContext);
      }
    }
    record = store.consumeContinuation(record.thread, { scope: record.scope, expectedVersion: record.version }, checkpoint.commitId, {
      thread: record.thread, scope: record.scope, owner: continuityProcessInstance(bindings.owner), logicalWorkId: consumerLogicalWorkId,
      instructionIdentity: work.instructionIdentity, nativeTurnId: identity.turnId, workPayloadDigest: work.workPayloadDigest,
      instructionPrevious: { instructionIdentity: work.instructionIdentity, nativeTurnId: work.nativeTurnId, checkpointDigest: checkpoint.summaryDigest },
      allowRetainedSourceFallback: true,
      snapshotDigest: recoveryDigest(input.context), createPage: !expected, dispatchProtocolComplete: true,
    });
  } else {
    record = store.reserveRecovery(record.thread, { scope: record.scope, expectedVersion: record.version }, {
      logicalWorkId: consumerLogicalWorkId, owner: continuityProcessInstance(bindings.owner), snapshotDigest: recoveryDigest(input.context),
    });
  }
  const consumer = record.works[consumerLogicalWorkId]!;
  parsed._continuityHistoryRevision = record.historyRevision;
  parsed._continuityEpoch = record.epoch;
  parsed._continuityAttempt = consumer.attempts.at(-1)!.attempt;
  input._continuityHistoryRevision = record.historyRevision;
  input._continuityEpoch = record.epoch;
  input._continuityAttempt = parsed._continuityAttempt;
  if (input === recoveredInput) {
    const source = contextCandidateCanonicalSource(parsed, input)!;
    source._continuityAttempt = input._continuityAttempt;
    source._continuityEpoch = input._continuityEpoch;
    source._continuityHistoryRevision = input._continuityHistoryRevision;
  }
  executionKey = `${namespace}:${chatGptTurnExecutionKey(parsed)}`;
  const sourceExecutionKey = binding?.executionKey;
  if (!expected) binding = bindings.installRecovered(record, executionKey, checkpoint.summaryDigest, identity.turnId);
  if (!binding) throw continuityError("continuity_source_unproven");
  // The journal has atomically selected this consumer. Publish that same execution
  // to retained checkpoint evidence; a successor attempt may have a different key.
  const retainedCheckpoint = [...binding.checkpoints.values()].find(value =>
    value.revision === checkpoint.targetHistoryRevision && continuityDigest(value.summary) === checkpoint.summaryDigest);
  if (retainedCheckpoint) retainedCheckpoint.continuationExecutionKey = executionKey;
  binding.recovery = { directory: bindings.registrations.directory, thread: record.thread, logicalWorkId: consumerLogicalWorkId,
    attempt: consumer.attempts.at(-1)!.attempt, ownerId: record.owner.id };
  const conversationKey = expected ? binding.conversation!.key : chatGptConversationKey(parsed, namespace)!;
  binding.conversation = { key: conversationKey, descriptor };
  return { bindings, binding, descriptor, conversationKey, executionKey, nativeThreadId: identity.threadId!, revision: record.historyRevision,
    sourceExecutionKey, expected, input, recovery: recoveryIdentity(record, store.installationId()), recovered: !expected,
    recoveryCheckpointId: checkpoint.commitId,
    allowRetainedSourceInstructionPayload: true,
    instructionPrevious: consumer.instructionPrevious ?? { instructionIdentity: work.instructionIdentity, nativeTurnId: work.nativeTurnId, checkpointDigest: checkpoint.summaryDigest } };
}
