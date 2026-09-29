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
  continuityBindingsFor, continuityCheckpoint, continuityCompactionSourceHistory, continuityDigest,
  type ContinuityBinding, type ContinuityBindings,
} from "./continuity-binding";
import { isContinuityLease, type ContinuityClaim, type ContinuityLease } from "./continuity-contract";
import { continuityError } from "./continuity-errors";
import { existingStructuredCompactionRun } from "./compaction-handoff";
import { preflightContinuityInput } from "./continuity-input";
import { chatGptConversationKey } from "./conversation-key";
import {
  continuityCurrentEnvironmentInput, extractChatGptTurnIdentity,
  hasInitialChatGptTurnInstruction, isRetainedCompactionSourceInstruction,
} from "./environment";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "./model";
import {
  chatGptCompactionSourceExecutionKey, chatGptDelegatedCompactionSourceExecutionKey,
  chatGptTurnExecutionKey, chatGptTurnRoundKey, chatGptTurnSessions,
  type ChatGptTurnSession,
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
  finalReplaySource?: ChatGptTurnSession;
  verifiedSourceHistory?: unknown[];
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

function ordinaryResumeInput(parsed: CodexParsedRequest, binding: ContinuityBinding, conversationKey: string): CodexParsedRequest {
  const source = binding.executionKey ? chatGptTurnSessions.find(binding.executionKey) : undefined;
  const outcome = source?.settledOutcome();
  if (!source || source !== chatGptTurnSessions.findConversationHead(conversationKey)
    || !source.isPhysicallySettled() || outcome?.type !== "final" || source.supersededError) {
    throw continuityError("continuity_source_unproven");
  }
  const prior = source.canonicalInput();
  const body = parsed._rawBody as { input?: unknown[] } | undefined;
  const current = body?.input;
  if (!prior || !Array.isArray(current) || current.length <= prior.length
    || !prior.every((item, index) => continuityDigest(item) === continuityDigest(current[index]))) {
    throw continuityError("continuity_source_unproven", "The new instruction does not extend the exact owned conversation head.");
  }
  let ownedOutputLength = source.recordedResponseOutputLength(current, prior.length, false);
  if (ownedOutputLength === undefined) {
    const anchor = parseRequest({ model: parsed.modelId, input: [current[prior.length]] }).context.messages;
    const ownedAssistant = anchor.length === 1 && anchor[0]?.role === "assistant" ? anchor[0] : undefined;
    const answer = ownedAssistant?.content.filter(part => part.type === "text").map(part => part.text).join("");
    if (!ownedAssistant || answer !== outcome.answer || ownedAssistant.content.some(part => part.type === "toolCall")) {
      throw continuityError("continuity_source_unproven", "The retained prompt suffix is not anchored to the completed source answer.");
    }
    ownedOutputLength = 1;
  }
  const suffix = current.slice(prior.length + ownedOutputLength);
  const messages = parseRequest({
    model: parsed.modelId,
    input: [...continuityCurrentEnvironmentInput(parsed), ...suffix],
  }).context.messages;
  if (messages.some(message => message.role === "assistant" || message.role === "toolResult" || message.role === "agentMessage")) {
    throw continuityError("continuity_source_unproven", "The retained prompt suffix contains unowned execution results.");
  }
  return { ...parsed, context: { ...parsed.context, messages } };
}

function checkpointResumeInput(
  parsed: CodexParsedRequest,
  binding: ContinuityBinding,
  proof: ReturnType<typeof continuityCheckpoint>,
): { input: CodexParsedRequest; finalReplaySource?: ChatGptTurnSession } {
  const checkpoint = [...binding.checkpoints.values()].find(value => value.revision === binding.revision);
  if (!checkpoint || proof.index < 0) throw continuityError("continuity_source_unproven");
  const body = parsed._rawBody as { input: unknown[] };
  // Summary text is not identity. The current revision plus the committed canonical
  // history position selects the valid occurrence when equal summaries appear twice.
  const exactPosition = checkpoint.historyPositions?.some(position => (
    position.length === proof.index
    && position.digest === continuityDigest(body.input.slice(0, proof.index))
  ));
  if (!exactPosition) {
    throw continuityError("continuity_source_unproven", "The checkpoint is not at an accepted canonical history position.");
  }
  const suffix = body.input.slice(proof.index + 1).filter(item => !isRetainedCompactionSourceInstruction(parsed, item));
  const suffixRequest = { ...parsed, _rawBody: { ...body, input: suffix } };
  const hasNewInstruction = hasInitialChatGptTurnInstruction(suffixRequest);
  const inputItems = [...continuityCurrentEnvironmentInput(parsed), ...suffix];
  const messages = parseRequest({ model: parsed.modelId, input: inputItems }).context.messages;
  if (messages.some(message => message.role === "assistant" || message.role === "toolResult" || message.role === "agentMessage")) {
    throw continuityError("continuity_source_unproven", "The checkpoint increment contains unowned execution results.");
  }
  const input = { ...parsed, context: { ...parsed.context, messages } };
  if (!checkpoint.preserveFinalResponse || hasNewInstruction) return { input };
  const source = chatGptTurnSessions.find(checkpoint.sourceExecutionKey);
  if (!source || source.supersededError || source.settledOutcome()?.type !== "final" || !source.isPhysicallySettled()) {
    throw continuityError("continuity_source_unproven", "The accepted ordinary answer is no longer available for replay.");
  }
  return { input, finalReplaySource: source };
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
      binding!.ordinaryReplayTombstones.get(candidate.executionKey) === candidate.revision
    ));
    const matchedRevisions = new Set([...exact, ...reclaimed].map(candidate => candidate.revision));
    if (matchedRevisions.size > 1) {
      throw continuityError("continuity_source_unproven", "The request matches more than one retained history revision.");
    }
    selected = exact[0] ?? reclaimed[0] ?? keyedCandidates.find(candidate => candidate.revision === binding!.revision)!;
    if (!selected) throw continuityError("continuity_source_unproven");
  }
  const { revision, executionKey } = selected;
  parsed._continuityHistoryRevision = revision;
  const conversationKey = chatGptConversationKey(parsed, namespace)!;
  let existing = chatGptTurnSessions.find(executionKey);
  if (binding && !parsed._compactionRequest && !existing
    && binding.ordinaryReplayTombstones.get(executionKey) === revision) {
    throw continuityError(
      "continuity_source_unproven",
      "The exact ordinary replay result was reclaimed; the request cannot be re-executed.",
    );
  }
  if (!binding && !hasInitialChatGptTurnInstruction(parsed)) throw continuityError("continuity_source_unproven");
  if (binding && !parsed._compactionRequest && existing) {
    existing.assertCanonicalReplayInput(parsed);
  }
  if (binding && revision !== binding.revision
    && !(parsed._compactionRequest && binding.checkpoints.has(executionKey))
    && !(existing?.roundCompleted(chatGptTurnRoundKey(parsed)) && !existing.isActive())) {
    throw continuityError("continuity_source_unproven", "An older history revision cannot start new work.");
  }
  let expected = binding?.lease ? { ...binding.lease } : undefined;
  const sourceExecutionKey = binding?.executionKey;
  let verifiedSourceHistory: unknown[] | undefined;
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
    verifiedSourceHistory = continuityCompactionSourceHistory(parsed);
    verifiedSourceGeneration = source.assertCompactionSourceHistory(verifiedSourceHistory);
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
  let input: CodexParsedRequest | undefined;
  let finalReplaySource: ChatGptTurnSession | undefined;
  if (!parsed._compactionRequest && !existing) {
    chatGptTurnSessions.assertContinuityThreadAvailable(identity.threadId, executionKey);
    if (binding && binding.state !== "ready"
      && !(binding.state === "creating" && binding.initialExecutionKey === executionKey && !expected)) {
      throw continuityError("continuity_source_unproven");
    }
    if (expected && binding?.executionKey === undefined && binding!.revision > 0) {
      ({ input, finalReplaySource } = checkpointResumeInput(parsed, binding!, checkpointProof));
    } else input = expected ? ordinaryResumeInput(parsed, binding!, conversationKey) : parsed;
    if (!finalReplaySource) preflightContinuityInput(input, capabilities, config.experimentalSkillAttachments, Boolean(expected));
  } else if (binding?.state === "compacting" && !parsed._compactionRequest
    && !existing?.roundCompleted(chatGptTurnRoundKey(parsed))) {
    throw continuityError("continuity_source_unproven");
  }
  if (!binding) {
    await assertLauncherContinuityCapacity(descriptor);
    abortSignal?.throwIfAborted();
    binding = bindings.create(thread, scope, executionKey, checkpoint, identity.turnId);
  }
  abortSignal?.throwIfAborted();
  binding.conversation ??= { key: conversationKey, descriptor };
  return {
    bindings, binding, descriptor, conversationKey, executionKey, nativeThreadId: identity.threadId,
    revision, sourceExecutionKey, expected, input, finalReplaySource, verifiedSourceHistory, verifiedSourceGeneration,
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
