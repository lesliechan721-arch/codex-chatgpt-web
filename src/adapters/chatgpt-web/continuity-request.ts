import { resolve } from "node:path";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { expandUserPath } from "../../config";
import {
  assertLauncherContinuityCapacity, assertLauncherContinuityFeature, inspectLauncherContinuityConversation,
  readLauncherBrowserHostDescriptor,
} from "../../launcher-browser-host";
import type { CodexParsedRequest, CodexProviderConfig } from "../../types";
import { parseRequest } from "../../responses/parser";
import type { ChatGptBrowserWorker } from "./browser-worker";
import {
  continuityBindingsFor, continuityCheckpoint, continuityDigest,
  type ContinuityBinding, type ContinuityBindings,
} from "./continuity-binding";
import { isContinuityLease, type ContinuityClaim, type ContinuityLease } from "./continuity-contract";
import { continuityError } from "./continuity-errors";
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
  verifiedSourceGeneration?: number;
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
  revision: number,
  proof: ReturnType<typeof continuityCheckpoint>,
): {
  input: CodexParsedRequest;
  instructionPrevious: ChatGptContinuityInstructionPrevious;
  allowRetainedSourceInstructionPayload: boolean;
  finalReplaySource?: ChatGptTurnSession;
} {
  const checkpoint = [...binding.checkpoints.values()].find(value => value.revision === revision);
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
    || config.experimentalBiggerContext || config.experimentalFreshConversationPerTurn
    || (config.browserInteractionMode === "manual") !== manual
    || (!manual && parsed.modelId !== CHATGPT_WEB_MODEL_ID)) throw continuityError("continuity_configuration_conflict");
  const descriptor = resolve(expandUserPath(config.browserHostDescriptorPath));
  try {
    assertLauncherContinuityFeature(readLauncherBrowserHostDescriptor(descriptor));
    if (!manual) await worker.assertContinuityCompatible();
  } catch {
    throw continuityError("continuity_configuration_conflict", "Update and restart Launcher and its helper before starting this mode.");
  }
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId || !identity.turnId) throw continuityError("continuity_source_unproven");
  const bindings = continuityBindingsFor(resolve(expandUserPath(config.continuityStateDirectory)));
  const thread = continuityDigest(identity.threadId);
  bindContinuityRequestScope(parsed, namespace);
  const scope = parsed._continuityScope!;
  let binding = bindings.lookup(thread, scope);
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
    const transitionTargets = parsed._compactionRequest || checkpointProof.index < 0 ? [] : keyedCandidates.filter(candidate => {
      const checkpointCommit = [...binding!.checkpoints.values()].find(value => value.revision === candidate.revision);
      if (!checkpointCommit) return false;
      return keyedCandidates.some(source => source.revision === checkpointCommit.sourceRevision
        && source.executionKey === checkpointCommit.sourceExecutionKey);
    });
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
  const sourceReplay = checkpointProof.index >= 0
    ? [...binding?.checkpoints.values() ?? []].find(value => value.revision === revision)?.sourceInstructionReplay : undefined;
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
    existing.continuityRoundKey(parsed);
  }
  if (binding && revision !== binding.revision
    && !(parsed._compactionRequest && binding.checkpoints.has(executionKey))
    && !existing?.roundCompleted(existing.continuityRoundKey(parsed))) {
    throw continuityError("continuity_source_unproven", "An older history revision cannot start new work.");
  }
  let expected = binding?.lease ? { ...binding.lease } : undefined;
  const sourceExecutionKey = binding?.executionKey;
  let verifiedSourceGeneration: number | undefined;
  const exactCurrentWork = (): boolean => Boolean(binding && (parsed._compactionRequest
    ? (binding.compactionKey === executionKey || binding.checkpoints.has(executionKey)) && existingStructuredCompactionRun(executionKey)
    : binding.executionKey === executionKey && chatGptTurnSessions.find(executionKey)));
  if (parsed._compactionRequest && binding && !binding.checkpoints.has(executionKey)
    && !(binding.state === "compacting" && binding.compactionKey === executionKey)) {
    let candidate: string | undefined;
    try {
      candidate = config.toolAuthorityMode === "delegated"
        ? chatGptDelegatedCompactionSourceExecutionKey(parsed)
        : chatGptCompactionSourceExecutionKey(parsed);
    } catch { /* A missing or malformed source is not a retained-page creation authority. */ }
    const source = sourceExecutionKey ? chatGptTurnSessions.find(sourceExecutionKey) : undefined;
    if (!candidate || `${namespace}:${candidate}` !== sourceExecutionKey || !source
      || source !== chatGptTurnSessions.findConversationHead(conversationKey)
      || source.supersededError || (binding.state === "compacting" && binding.compactionKey !== executionKey)) {
      if (config.toolAuthorityMode === "delegated" && source) {
        source.cancel(continuityError("continuity_source_unproven"));
        await source.runtime.retireCapability?.();
        bindings.lose(binding, sourceExecutionKey);
      }
      throw continuityError("continuity_source_unproven");
    }
    try {
      source.assertContinuitySourceInstruction(parsed);
    } catch (error) {
      if (config.toolAuthorityMode === "delegated") {
        const reason = error instanceof Error ? error : continuityError("continuity_source_unproven");
        source.cancel(reason);
        await source.runtime.retireCapability?.();
        bindings.lose(binding, sourceExecutionKey);
      }
      throw error;
    }
    verifiedSourceGeneration = source.continuityGenerationValue();
  }
  if (binding && expected) {
    try { await inspectLauncherContinuityConversation(descriptor, conversationKey, expected); }
    catch {
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
  if (!parsed._compactionRequest && !existing) {
    assertNoUnownedTerminalResults(parsed, checkpointProof.index);
    chatGptTurnSessions.assertContinuityThreadAvailable(identity.threadId, executionKey);
    if (binding && binding.state !== "ready"
      && !(binding.state === "creating" && binding.initialExecutionKey === executionKey && !expected)) {
      throw continuityError("continuity_source_unproven");
    }
    if (expected && binding?.executionKey === undefined && binding!.revision > 0) {
      ({ input, instructionPrevious, allowRetainedSourceInstructionPayload, finalReplaySource } = checkpointResumeInput(
        parsed,
        binding!,
        revision,
        checkpointProof,
      ));
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
  return {
    bindings, binding, descriptor, conversationKey, executionKey, nativeThreadId: identity.threadId,
    revision, sourceExecutionKey, expected, input, instructionPrevious,
    allowRetainedSourceInstructionPayload, finalReplaySource, verifiedSourceGeneration,
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
  return bindings.beginResponse(binding, prepared.executionKey);
}

export function acceptContinuityResponseLease(prepared: PreparedContinuityRequest, traceId: string, value: unknown): ContinuityLease {
  if (!isContinuityLease(value) || value.traceId !== traceId || prepared.binding.executionKey !== prepared.executionKey) {
    throw continuityError("continuity_session_lost");
  }
  prepared.bindings.acceptLease(prepared.binding, value);
  return { ...value };
}

export async function finishContinuityResponse(prepared: PreparedContinuityRequest): Promise<void> {
  const { binding, bindings } = prepared;
  if (!binding.lease || binding.executionKey !== prepared.executionKey) throw continuityError("continuity_session_lost");
  const physical = await inspectLauncherContinuityConversation(prepared.descriptor, prepared.conversationKey, binding.lease);
  if (physical.state !== "ready") throw continuityError("continuity_session_lost");
  bindings.responseReady(binding, prepared.executionKey);
}
