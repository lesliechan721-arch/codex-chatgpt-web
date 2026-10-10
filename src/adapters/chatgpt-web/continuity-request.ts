import { selectRecoveryContinuation } from "./continuity-recovery-continuation";
import { continuityProcessInstance, continuityProcessInstanceStatus, type RecoveryThreadRecord } from "./continuity-recovery-store";
import { recoveryContext, recoveryDigest, recoveryIdentity, retireRecoveryWriter, type RuntimeRecoveryReference } from "./continuity-recovery-runtime";
import type { ContinuityRecoveryIdentity } from "./continuity-contract";
import { resolve } from "node:path";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { expandUserPath } from "../../config";
import {
  assertLauncherContinuityCapacity, assertLauncherContinuityFeature, inspectLauncherContinuityConversation,
  readLauncherBrowserHostDescriptor, queryLauncherContinuityTransaction, updateLauncherContinuityPreparation, retireLauncherContinuityWriter,
} from "../../launcher-browser-host";
import type { CodexParsedRequest, CodexProviderConfig } from "../../types";
import { parseRequest } from "../../responses/parser";
import type { ChatGptBrowserWorker } from "./browser-worker";
import {
  continuityBindingsFor, continuityCheckpoint, continuityDigest,
  selectContinuityCheckpoint, type ContinuityCheckpointCommit, type ContinuityCheckpointSelection, type ContinuityBinding, type ContinuityBindings,
} from "./continuity-binding";
import { isContinuityLease, type ContinuityClaim, type ContinuityLease } from "./continuity-contract";
import { continuityError } from "./continuity-errors";
import { taskUpdateSourceError } from "./task-update-source";
import { continuityToolRegistry } from "./continuity-tools";
import { isAcceptedCompactionContinuation } from "./compaction-continuation";
import { existingStructuredCompactionRun } from "./compaction-handoff";
import { preflightContinuityInput } from "./continuity-input";
import { chatGptConversationKey } from "./conversation-key";
import {
  chatGptCurrentInstructionIndex, chatGptInstructionContent, chatGptInstructionEnvelope,
  continuityCurrentEnvironmentInput, continuityCurrentInstructionInput, extractChatGptTurnIdentity,
  hasInitialChatGptTurnInstruction, hasNativeChatGptInstruction,
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
  /** The exact accepted checkpoint selected for this recovery input. */
  recoveryCheckpointId?: string;
}

function sameLease(left: ContinuityLease | undefined, right: ContinuityLease | undefined): boolean {
  return left?.owner === right?.owner && left?.leaseId === right?.leaseId && left?.traceId === right?.traceId;
}

export function bindContinuityRequestScope(parsed: CodexParsedRequest, namespace: string): void {
  if (parsed._conversationPolicy === "continuity-first") {
    parsed._continuityScope = continuityDigest([namespace, parsed.modelId, parsed._chatgptModelFamily ?? null, parsed.options.reasoning ?? null]);
  } else delete parsed._continuityScope;
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
  const selectedContext = parseRequest({
    model: parsed.modelId,
    instructions: (parsed._rawBody as { instructions?: unknown }).instructions,
    input: [...continuityCurrentEnvironmentInput(parsed, suffix), ...suffix],
  }).context;
  const messages = selectedContext.messages;
  if (messages.some(message => message.role === "assistant"
    || (message.role === "toolResult" && message.toolCallId !== undefined))) {
    throw continuityError("continuity_source_unproven", "The current instruction selection contains execution output.");
  }
  return { input: { ...parsed, context: { ...parsed.context, systemPrompt: selectedContext.systemPrompt, messages } }, instructionPrevious };
}

function assertNoUnownedTerminalResults(parsed: CodexParsedRequest, checkpointIndex: number): void {
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) throw continuityError("continuity_source_unproven");
  const lowerBound = Math.max(chatGptCurrentInstructionIndex(parsed), checkpointIndex) + 1;
  for (let index = lowerBound; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const type = (item as { type?: unknown }).type;
    if (type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_search_output") {
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
): {
  input: CodexParsedRequest;
  instructionPrevious: ChatGptContinuityInstructionPrevious;
  allowRetainedSourceInstructionPayload: boolean;
  finalReplaySource?: ChatGptTurnSession;
} {
  if (!checkpoint?.sourceInstructionReplay || proof.index < 0) throw continuityError("continuity_source_unproven");
  const instructionPrevious = {
    instructionIdentity: checkpoint.sourceInstructionReplay.instructionIdentity,
    nativeTurnId: checkpoint.sourceInstructionReplay.nativeTurnId,
    checkpointDigest: proof.digest,
  };
  const suffix = continuityCurrentInstructionInput(parsed, { ...instructionPrevious, trustedLowerBound: proof.index });
  const hasNewInstruction = hasInitialChatGptTurnInstruction(parsed) && hasNativeChatGptInstruction(parsed, suffix);
  if (hasNewInstruction) chatGptTurnSessions.assertUnconsumedContinuityInstruction(binding, parsed);
  else if (continuityInstructionIdentity(parsed) !== instructionPrevious.instructionIdentity) {
    throw continuityError("continuity_source_unproven", "The checkpoint continuation does not identify its committed source instruction.");
  }
  const inputItems = [...continuityCurrentEnvironmentInput(parsed, suffix), ...suffix];
  const selectedContext = parseRequest({
    model: parsed.modelId,
    instructions: (parsed._rawBody as { instructions?: unknown }).instructions,
    input: inputItems,
  }).context;
  const messages = selectedContext.messages;
  if (messages.some(message => message.role === "assistant"
    || (message.role === "toolResult" && message.toolCallId !== undefined))) {
    throw continuityError("continuity_source_unproven", "The checkpoint continuation contains execution output.");
  }
  const input = { ...parsed, context: { ...parsed.context, systemPrompt: selectedContext.systemPrompt, messages } };
  if (!checkpoint.preserveFinalResponse || hasNewInstruction) {
    return { input, instructionPrevious, allowRetainedSourceInstructionPayload: !hasNewInstruction };
  }
  const source = chatGptTurnSessions.find(checkpoint.sourceExecutionKey);
  if (!source || source.supersededError || source.settledOutcome()?.type !== "final" || !source.isPhysicallySettled()) {
    throw continuityError("continuity_source_unproven", "The accepted ordinary answer is no longer available for replay.");
  }
  return { input, instructionPrevious, allowRetainedSourceInstructionPayload: true, finalReplaySource: source };
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

/** A stopped instruction is terminal even when a newer instruction owns the live binding. */
export function assertContinuityStoppedReceipt(parsed: CodexParsedRequest): void {
  if (parsed._conversationPolicy !== "continuity-first" || parsed._compactionRequest
    || !parsed._continuityStateDirectory || !parsed._continuityScope) return;
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId || !identity.turnId) return;
  const record = continuityBindingsFor(parsed._continuityStateDirectory).recoveryStore.get(continuityDigest(identity.threadId));
  if (!record || record.scope !== parsed._continuityScope || record.legacyUnproven) return;
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

/** Resolves trusted history identity before trace/replay lookup or browser/clipboard mutation. */
export async function prepareContinuityRequest(
  parsed: CodexParsedRequest,
  provider: CodexProviderConfig,
  namespace: string,
  capabilities: ChatGptWebCapabilities,
  worker: ChatGptBrowserWorker,
  abortSignal?: AbortSignal,
): Promise<PreparedContinuityRequest> {
  abortSignal?.throwIfAborted();
  const config = provider.chatgptWeb;
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  if (parsed._conversationPolicy !== "continuity-first" || !config?.continuityStateDirectory
    || !config.localToolsEnabled || config.browserHost !== "launcher" || !config.browserHostDescriptorPath
    || config.experimentalFreshConversationPerTurn
    || (config.browserInteractionMode === "manual") !== manual
    || (!manual && parsed.modelId !== CHATGPT_WEB_MODEL_ID)) throw continuityError("continuity_configuration_conflict");
  const descriptor = resolve(expandUserPath(config.browserHostDescriptorPath));
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId || !identity.turnId) throw continuityError("continuity_source_unproven");
  const bindings = continuityBindingsFor(resolve(expandUserPath(config.continuityStateDirectory)));
  const thread = continuityDigest(identity.threadId);
  bindContinuityRequestScope(parsed, namespace);
  const scope = parsed._continuityScope!;
  parsed._continuityStateDirectory = bindings.registrations.directory;
  let binding = bindings.lookup(thread, scope);
  const durable = bindings.recoveryStore.get(thread);
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
  if (parsed._compactionRequest) {
    const { prepareRecoveryCompaction } = await import("./continuity-recovery-compaction");
    const prepared = await prepareRecoveryCompaction(parsed, provider, namespace, capabilities, worker, bindings, durable, descriptor, abortSignal, assertExecutionCompatible);
    if (prepared) return prepared;
  }
  const initialLocalOwner = binding?.executionKey ? chatGptTurnSessions.find(binding.executionKey) : undefined;
  if (!parsed._compactionRequest && initialLocalOwner?.nativeTurnId === identity.turnId) initialLocalOwner.bindContinuityResultSource(parsed);
  if (!parsed._compactionRequest && durable) {
    const checkpointPrepared = await prepareDurableContinuation(parsed, namespace, capabilities, config.experimentalSkillAttachments, bindings, durable, descriptor, abortSignal, assertExecutionCompatible);
    if (checkpointPrepared) return checkpointPrepared;
    const recovered = await prepareDurableOrdinary(parsed, namespace, capabilities, config.experimentalSkillAttachments, bindings, durable, descriptor, abortSignal, assertExecutionCompatible);
    if (recovered) return recovered;
    binding = bindings.lookup(thread, scope);
  }
  parsed._continuityEpoch = binding?.epoch ?? durable?.epoch ?? 0;
  const currentInstruction = !parsed._compactionRequest ? continuityInstructionIdentity(parsed) : undefined;
  const currentWork = currentInstruction && durable ? Object.values(durable.works).find(work => work.instructionIdentity === currentInstruction && work.nativeTurnId === identity.turnId && work.purpose === "ordinary") : undefined;
  if (currentWork) parsed._continuityAttempt = currentWork.attempts.at(-1)!.attempt;
  const localOwner = binding?.executionKey ? chatGptTurnSessions.find(binding.executionKey) : undefined;
  const appendSource = !parsed._compactionRequest && binding?.lease && localOwner?.isActive()
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
  const conversationKey = chatGptConversationKey(parsed, namespace)!;
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
    if (!candidate || `${namespace}:${candidate}` !== (binding.logicalExecutionKey ?? sourceExecutionKey) || !source
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
    try { await inspectLauncherContinuityConversation(descriptor, conversationKey, expected); }
    catch (inspectionError) {
      if ((inspectionError as { code?: string }).code === "continuity_unverified" && sameLease(binding.lease, expected)) {
        binding.state = "unverified";
        throw inspectionError;
      }
      // Another observer of this exact transaction can advance the physical head while this
      // read is in flight. An obsolete proof must never retire the newly accepted lease.
      if (!sameLease(binding.lease, expected)) {
        if (!exactCurrentWork() || !binding.lease) throw continuityError("continuity_source_unproven");
        expected = { ...binding.lease };
        try { await inspectLauncherContinuityConversation(descriptor, conversationKey, expected); }
        catch {
          if (!sameLease(binding.lease, expected)) throw continuityError("continuity_source_unproven");
          bindings.lose(binding, binding.executionKey);
          throw continuityError("continuity_session_lost");
        }
      } else {
        bindings.lose(binding, sourceExecutionKey);
        const current = bindings.recoveryStore.get(thread);
        if (!parsed._compactionRequest && current) {
          const recovered = await prepareDurableOrdinary(parsed, namespace, capabilities, config.experimentalSkillAttachments, bindings, current, descriptor, abortSignal);
          if (recovered) return recovered;
        }
        throw continuityError("continuity_session_lost");
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
  if (!parsed._compactionRequest && !existing && appendSource) {
    if (!appendSource.taskUpdatesEnabled()) {
      throw taskUpdateSourceError("task_update_upgrade_required", "This append was not accepted because the active response did not negotiate task-updates-v1. Its current work continues.");
    }
    if (binding!.state === "compacting") throw taskUpdateSourceError("task_update_compaction_pending", "This append was not accepted because context compaction owns the current source.");
  } else if (!parsed._compactionRequest && !existing) {
    assertNoUnownedTerminalResults(parsed, checkpointProof.index);
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
      input = structuredClone(binding.initialAcceptedInput);
    } else input = parsed;
    if (!finalReplaySource) preflightContinuityInput(input, capabilities, config.experimentalSkillAttachments, Boolean(expected));
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
      logicalWorkId: recoveryDigest([scope, identity.turnId, continuityInstructionIdentity(parsed), "ordinary"]),
      instructionIdentity: continuityInstructionIdentity(parsed), nativeTurnId: identity.turnId,
      workPayloadDigest: payloadDigest, snapshotDigest: recoveryDigest(input!.context), createPage: true, dispatchProtocolComplete: true });
    binding = bindings.create(thread, scope, executionKey, checkpoint, identity.turnId);
    if (binding.initialAcceptedInput) {
      if (binding.initialInstructionPayloadDigest !== payloadDigest) {
        throw continuityError("continuity_source_unproven", "The accepted native instruction identity now carries a different current payload.");
      }
      input = structuredClone(binding.initialAcceptedInput);
    } else {
      binding.initialAcceptedInput = structuredClone(input!);
      binding.initialInstructionPayloadDigest = payloadDigest;
    }
  }
  abortSignal?.throwIfAborted();
  binding.conversation ??= { key: conversationKey, descriptor };
  let recovery: ContinuityRecoveryIdentity | undefined;
  if (!parsed._compactionRequest && input && !finalReplaySource) {
    const logicalWorkId = recoveryDigest([scope, identity.turnId, continuityInstructionIdentity(parsed), "ordinary"]);
    if (instructionPrevious && !instructionPrevious.instructionIdentity) throw continuityError("continuity_source_unproven");
    const record = bindings.recoveryStore.admitWork({ thread, scope, owner: continuityProcessInstance(bindings.owner),
      logicalWorkId, instructionIdentity: continuityInstructionIdentity(parsed), nativeTurnId: identity.turnId,
      workPayloadDigest: chatGptContinuityInstructionPayloadDigest(parsed, instructionPrevious, allowRetainedSourceInstructionPayload),
      instructionPrevious: instructionPrevious ? { ...instructionPrevious, instructionIdentity: instructionPrevious.instructionIdentity! } : undefined,
      allowRetainedSourceFallback: allowRetainedSourceInstructionPayload,
      snapshotDigest: recoveryDigest(input.context), createPage: !expected, dispatchProtocolComplete: true });
    binding.recovery = { directory: bindings.registrations.directory, thread, logicalWorkId, attempt: record.works[logicalWorkId]!.attempts.at(-1)!.attempt, ownerId: record.owner.id };
    recovery = recoveryIdentity(record, bindings.recoveryStore.installationId());
  }
  return {
    bindings, binding, descriptor, conversationKey, executionKey, nativeThreadId: identity.threadId,
    revision, sourceExecutionKey, expected, input, instructionPrevious,
    allowRetainedSourceInstructionPayload, finalReplaySource, verifiedSourceGeneration,
    checkpointTransition,
    appendSource, recovery,
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
    if (["prepared", "page-possible", "page-acquired"].includes(attempt.stage)) prepared.bindings.recoveryStore.markAttempt(ref.thread, { scope: record.scope }, { logicalWorkId: ref.logicalWorkId, attempt: ref.attempt, stage: "page-acquired", pageReceiptId: value.leaseId, transactionVersion: prepared.recovery?.transactionVersion });
  }
  prepared.bindings.acceptLease(prepared.binding, value);
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
async function prepareDurableOrdinary(
  parsed: CodexParsedRequest, namespace: string, capabilities: ChatGptWebCapabilities,
  attachments: boolean | undefined, bindings: ContinuityBindings, observed: RecoveryThreadRecord,
  descriptor: string, abortSignal?: AbortSignal, assertExecutionCompatible?: () => Promise<void>,
): Promise<PreparedContinuityRequest | undefined> {
  const identity = extractChatGptTurnIdentity(parsed);
  const liveBinding = bindings.observed(observed.thread);
  const instruction = continuityInstructionIdentity(parsed);
  const store = bindings.recoveryStore;
  const logicalWorkId = recoveryDigest([observed.scope, identity.turnId, instruction, "ordinary"]);
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
    try {
      const physical = await inspectLauncherContinuityConversation(descriptor, binding.conversation.key, binding.lease);
      binding.state = physical.state === "ready" ? "ready" : "running";
    } catch (error) {
      if ((error as { code?: string }).code === "continuity_unverified") throw error;
      bindings.lose(binding, binding.executionKey);
    }
  }
  if (binding && !["lost", "ended"].includes(binding.state) && record.owner.id === bindings.owner) return undefined;
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
  if (work || previous.state !== "completed") input = recoveryContext(parsed, ref, recoveryCheckpoint?.commitId);
  if (work && binding?.initialAcceptedInput && ["prepared", "page-possible", "page-acquired"].includes(work.attempts.at(-1)!.stage)) input = structuredClone(binding.initialAcceptedInput);
  preflightContinuityInput(input, capabilities, attachments, false);
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
      try { receipt = await retireLauncherContinuityWriter(descriptor, target); }
      catch { receipt = await retireLauncherContinuityWriter(descriptor, expected); }
      if (!receipt.writerRetired) throw continuityError("continuity_unverified");
      record = store.retirePreparation(record.thread, { scope: record.scope, expectedVersion: record.version }, pending.preparationId);
    } else {
      let missing = false;
      try {
        const receipt = await updateLauncherContinuityPreparation(descriptor, { expected, recovery: target });
        if (receipt.state !== "prepared") throw continuityError("continuity_execution_unsettled");
      } catch (error) {
        // A host restart may erase both tags, but an absent table alone is not a
        // retirement proof. This branch can only close the unsent migration after
        // the original Broker process and the original Launcher are proved gone.
        const receipt = await queryLauncherContinuityTransaction(descriptor, target).catch(() => undefined);
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
  const unsentCandidate = work && attemptBefore && ["prepared", "page-possible", "page-acquired"].includes(attemptBefore.stage)
    && work.retryBudget?.lastFailureAt === undefined
    && !binding?.initialAcceptedInput
    && (record.owner.id === bindings.owner || continuityProcessInstanceStatus(record.owner) === "exited");
  let sameAttempt = false;
  if (unsentCandidate) {
    const previousIdentity = recoveryIdentity(record, store.installationId());
    const receipt = await queryLauncherContinuityTransaction(descriptor, previousIdentity);
    // Creating is still the original acquisition. Keep its sole queryable identity
    // and wait for a prepared receipt; do not create a migration or another page.
    if (receipt.state === "creating") throw continuityError("continuity_unverified", "The original page acquisition is still in progress.");
    if (!["missing", "prepared", "retired"].includes(receipt.state)) throw continuityError("continuity_execution_unsettled");
    if (receipt.state === "missing" && (!receipt.hostNoWriter
      || (attemptBefore.launcherInstance ? !receipt.writerRetired : attemptBefore.stage !== "prepared"))) throw continuityError("continuity_unverified");
    if (receipt.state === "prepared") {
      if (!receipt.launcherInstance) throw continuityError("continuity_unverified");
      if (record.owner.id !== bindings.owner || record.transaction!.snapshotDigest !== recoveryDigest(input.context)) {
        record = store.beginPreparation(record.thread, { scope: record.scope, expectedVersion: record.version }, {
          logicalWorkId, owner: continuityProcessInstance(bindings.owner), snapshotDigest: recoveryDigest(input.context),
          launcherInstance: receipt.launcherInstance,
        });
        const pending = record.pendingPreparation!;
        const prepared = await updateLauncherContinuityPreparation(descriptor, { expected: previousIdentity,
          recovery: recoveryIdentity({ ...record, ...pending.target }, store.installationId()) });
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
  if (!sameAttempt) record = await retireRecoveryWriter(bindings, record, descriptor);
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
  const executionKey = `${namespace}:${chatGptTurnExecutionKey(parsed)}`;
  const checkpoint = continuityCheckpoint(parsed);
  const restored = bindings.installRecovered(record, executionKey, checkpoint.digest, identity.turnId);
  restored.initialAcceptedInput = structuredClone(input);
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
  descriptor: string, abortSignal?: AbortSignal, assertExecutionCompatible?: () => Promise<void>,
): Promise<PreparedContinuityRequest | undefined> {
  const proof = continuityCheckpoint(parsed);
  if (proof.index < 0 || hasNativeChatGptInstruction(parsed,
    continuityCurrentInstructionInput(parsed, { trustedLowerBound: proof.index }))) return undefined;
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
    return prepareDurableContinuation(parsed, namespace, capabilities, attachments, bindings, beforeRecovery, descriptor, abortSignal);
  }
  let input = recoveryContext(parsed, { directory: bindings.registrations.directory, thread: record.thread,
    logicalWorkId: work.logicalWorkId, attempt: work.attempts.at(-1)!.attempt }, checkpoint.commitId);
  // recoveryContext can accept a first real result synchronously. Observe that write
  // before waiting on the page; later version changes still require reconciliation.
  record = store.get(record.thread)!;
  let expected = selection.action === "admit" && binding?.state === "ready" ? binding.lease : undefined;
  if (expected && binding?.conversation) {
    try { await inspectLauncherContinuityConversation(descriptor, binding.conversation.key, expected); }
    catch (error) {
      if ((error as { code?: string }).code === "continuity_unverified") throw error;
      expected = undefined;
    }
  }
  // Another observer can consume or finish this exact transition while the page
  // inspection is in flight. Reconcile that receipt before retiring any writer.
  const afterInspection = store.get(record.thread)!;
  if (afterInspection.version !== record.version) {
    return prepareDurableContinuation(parsed, namespace, capabilities, attachments, bindings, afterInspection, descriptor, abortSignal);
  }
  if (expected && binding && localCheckpoint) input = checkpointResumeInput(parsed, binding, localCheckpoint, proof).input;
  parsed.context.tools = continuityToolRegistry(parsed, binding, existing).tools;
  input.context.tools = parsed.context.tools;
  preflightContinuityInput(input, capabilities, attachments, Boolean(expected));
  if (!expected) {
    await assertLauncherContinuityCapacity(descriptor);
    record = await retireRecoveryWriter(bindings, record, descriptor);
  }
  abortSignal?.throwIfAborted();
  if (selection.action === "admit") {
    const current = store.get(record.thread)!;
    if (current.version !== record.version) {
      const currentCheckpoint = current.checkpoints[checkpoint.commitId];
      if (currentCheckpoint?.continuation.state === "consumed"
        && currentCheckpoint.continuation.consumerLogicalWorkId === consumerLogicalWorkId) {
        return prepareDurableContinuation(parsed, namespace, capabilities, attachments, bindings, current, descriptor, abortSignal);
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
  input = { ...input, _continuityHistoryRevision: record.historyRevision, _continuityEpoch: record.epoch, _continuityAttempt: parsed._continuityAttempt };
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
