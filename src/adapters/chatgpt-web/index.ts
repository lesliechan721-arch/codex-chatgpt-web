import { observedTaskAcknowledgement } from "./task-update-ack";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { defaultBrokerEndpoint, expandUserPath, resolveBrokerEndpoint } from "../../config";
import {
  cancelLauncherManualTurn,
  endLauncherManualTurn,
  LauncherBrowserTurnCancelledError,
  LauncherManualTurnFailedError,
  LauncherManualTurnTimedOutError,
  markLauncherManualTurnStarted,
  releaseLauncherRetainedConversation,
  startLauncherManualTurn,
  waitForLauncherManualSent,
  waitForLauncherManualTerminal,
  type LauncherManualTurnEnd,
  type LauncherManualTurnOwner,
  type LauncherManualTurnStart,
} from "../../launcher-browser-host";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage } from "../../types";
import type { ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { ChatGptWebAdapterError, chatGptToolTimeoutError } from "./adapter-error";
import { ChatGptBrowserWorker } from "./browser-worker";
import {
  extractChatGptDelegatedTurnCapability,
  extractChatGptCompactionSourceRevision,
  extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
  priorChatGptAbortedTurnIds,
  trustedEnvironmentRequestDetails,
  trustedEnvironmentRequestFingerprint,
  type ChatGptTurnCapability,
} from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from "./prompt";
import { createChatGptStructuredOutputValidator } from "./output-validation";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { TurnBroker, type BrokerToolRequest, type BrokerToolResult, type TurnBrokerOwner } from "./turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptDelegatedCompactionSourceExecutionKey, chatGptInstructionLineage, chatGptThreadOwnershipKey, chatGptTurnExecutionKey, chatGptTurnRetryKey, chatGptTurnRoundKey, chatGptTurnSessions, TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES, TASK_UPDATE_SESSION_JOURNAL_BYTES, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "./usage";
import { ChatGptThreadEnvironmentStore, trustedEnvironmentFailureDetails, type ChatGptEnvironmentResolutionDiagnostics } from "./thread-environment";
import {
  ChatGptLunaCheckpointStore,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import { ChatGptExternalTurnProgress } from "./turn-progress";
import { NativeOperationError } from "./native-tool-operations";
import { mirrorLatestTaskUpdateState, tryTaskUpdateHandoff } from "./task-update-handoff";
import { captureTaskUpdateSource, taskUpdateSourceError, type TaskUpdateExecutionIdentity } from "./task-update-source";
import { canonicalJson } from "./canonical-json";
import type { TaskUpdateOwnerContext } from "./task-update-protocol";
import { continuityError } from "./continuity-errors";
import { continuityToolRegistry } from "./continuity-tools";
import { leaveContinuityMode } from "./continuity-lifecycle";
import { assertContinuityCompiledInput } from "./continuity-input";
import { assertContinuityCompactionResult, runContinuityCompaction } from "./continuity-compaction";
import type { ContinuityLease } from "./continuity-contract";
import {
  acceptContinuityResponseLease, beginContinuityResponse, bindContinuityRequestScope, finishContinuityResponse,
  prepareContinuityRequest, type PreparedContinuityRequest,
} from "./continuity-request";
import {
  canonicalizeCompactionHandoff,
  existingStructuredCompactionRun,
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  settleActiveZeroRiskCompactionSource,
} from "./compaction-handoff";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "./conversation-key";

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof ChatGptWebAdapterError) return signal.reason;
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

function cancellableBrowserTurn(
  run: Promise<string>,
  controller: AbortController,
): { browser: Promise<string>; physicalSettlement: Promise<void>; cancel: (reason?: Error) => void } {
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let cancellationRejected = false;
  return {
    // Cancellation wins immediately even while the detached Playwright helper is still unwinding.
    // The helper keeps the same abort signal and remains responsible for its normal end/cleanup
    // handshake, but the Codex Responses turn no longer waits on that process cleanup.
    browser: Promise.race([run, cancellation]),
    // `browser` is the fast client-facing result. Replacement ownership must wait for the actual
    // worker promise, whose finally block completes the launcher /turn/end handshake.
    physicalSettlement: run.then(() => undefined, () => undefined),
    cancel(reason?: Error) {
      if (!controller.signal.aborted) controller.abort(reason);
      // Explicit targeted cancellation ends the Codex Responses turn immediately. Generic
      // retirement (client disconnect or compaction replacement) still waits for the helper's
      // cleanup handshake before a replacement browser may start.
      if (reason && !cancellationRejected) {
        cancellationRejected = true;
        rejectCancellation(reason);
      }
    },
  };
}

export interface ChatGptZeroRiskManualControl {
  start(descriptorPath: string, activity: LauncherManualTurnStart): Promise<unknown>;
  waitSent(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
  waitTerminal(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ status: "cancelled" | "failed" }>;
  markStarted(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
  ): Promise<void>;
  end(descriptorPath: string, activity: LauncherManualTurnEnd): Promise<unknown>;
  cancel(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
}

const launcherZeroRiskManualControl: ChatGptZeroRiskManualControl = {
  start: startLauncherManualTurn,
  waitSent: waitForLauncherManualSent,
  waitTerminal: waitForLauncherManualTerminal,
  markStarted: markLauncherManualTurnStarted,
  end: endLauncherManualTurn,
  cancel: cancelLauncherManualTurn,
};

function safeManualAdapterError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  if (error instanceof ChatGptWebAdapterError) return error;
  if (error instanceof LauncherManualTurnTimedOutError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 408,
      errorType: "invalid_request_error",
      code: "manual_handoff_timeout",
      retryable: false,
    });
  }
  if (error instanceof LauncherBrowserTurnCancelledError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  if (error instanceof LauncherManualTurnFailedError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 502,
      errorType: "server_error",
      code: "manual_launcher_failed",
      retryable: false,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function safeManualTerminalError(status: "cancelled" | "failed"): ChatGptWebAdapterError {
  if (status === "cancelled") {
    return new ChatGptWebAdapterError("The Zero Risk browser turn was cancelled in the Launcher", {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  return new ChatGptWebAdapterError("The Zero Risk browser tab failed before ChatGPT completed the turn", {
    status: 502,
    errorType: "server_error",
    code: "manual_launcher_failed",
    retryable: false,
  });
}

export function chatGptWebExecutionNamespace(provider: CodexProviderConfig): string {
  return createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
}

export function chatGptWebTraceId(provider: CodexProviderConfig, parsed: CodexParsedRequest): string {
  const namespace = chatGptWebExecutionNamespace(provider);
  // The logical response key survives compaction so a final answer that won the handoff race
  // can still be replayed. A new physical browser owner must instead belong to the new context
  // epoch; otherwise Zero Risk correctly rejects it against the previous owner's completion.
  const conversation = parsed._compactionRequest ? undefined : chatGptConversationKey(parsed, namespace);
  return createHash("sha256")
    .update(`${namespace}:${chatGptTurnExecutionKey(parsed)}`)
    .update(conversation ? `:${conversation}` : "")
    .digest("hex")
    .slice(0, 12);
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function brokerResult(message: CodexToolResultMessage, raw?: Record<string, unknown>): BrokerToolResult {
  const original = raw?.output && typeof raw.output === "object" && !Array.isArray(raw.output)
    ? raw.output as Record<string, unknown> : undefined;
  if (original && Array.isArray(original.content)) {
    return structuredClone({ content: original.content,
      ...("structuredContent" in original ? { structuredContent: original.structuredContent } : {}),
      ...(typeof original.isError === "boolean" ? { isError: original.isError } : {}),
      ...("_meta" in original ? { _meta: original._meta } : {}) });
  }
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(raw && "structuredContent" in raw ? { structuredContent: structuredClone(raw.structuredContent) }
      : structured !== undefined ? { structuredContent: structured } : {}),
    ...(typeof raw?.isError === "boolean" ? { isError: raw.isError } : message.isError ? { isError: true } : {}),
    ...(raw && "_meta" in raw ? { _meta: structuredClone(raw._meta) } : {}),
  };
}

function rawToolResult(parsed: CodexParsedRequest, callId: string): Record<string, unknown> | undefined {
  const body = parsed._rawBody as { input?: unknown[] } | undefined;
  return body?.input?.find((value): value is Record<string, unknown> => value !== null
    && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).call_id === callId
    && ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(String((value as Record<string, unknown>).type)));
}

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

interface StructuredCompactionResult {
  summary: string;
  path: "retained" | "fresh";
  fallbackReason?: string;
}

function emitBrowserCompletion(
  outcome: ChatGptBrowserOutcome,
  usage: CodexUsage,
  emit: (event: AdapterEvent) => void,
  responseMetadata?: Record<string, string>,
): void {
  if (outcome.type === "error") throw outcome.error;
  emit({
    type: "done",
    stopReason: "stop",
    endTurn: true,
    usage,
    ...(responseMetadata ? { responseMetadata } : {}),
  });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function emitReadOnlyContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

function submittedTurnFailure(session: ChatGptTurnSession, error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (normalized instanceof ChatGptWebAdapterError) return normalized;
  if (normalized instanceof NativeOperationError) {
    return new ChatGptWebAdapterError(normalized.message, {
      status: 502, errorType: "server_error", code: normalized.code, retryable: false, cause: normalized,
    });
  }
  const phase = session.runtime.submission?.phase;
  if (!phase || phase === "prepared") return normalized;
  const ambiguous = phase === "send_activated";
  return new ChatGptWebAdapterError(
    ambiguous
      ? "ChatGPT did not confirm that the prompt was sent. Check the ChatGPT tab before continuing."
      : "ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.",
    {
      status: 502,
      errorType: "server_error",
      code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
      retryable: false,
      cause: normalized,
    },
  );
}

function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

function taskUpdateExecutionIdentity(
  environment: ChatGptTurnCapability,
  namespace: string,
  parsed: CodexParsedRequest,
): TaskUpdateExecutionIdentity {
  const { tools: _tools, ...capabilityIdentity } = environment;
  return { capabilityIdentity, executionConfig: { namespace, systemPrompt: parsed.context.systemPrompt ?? null } };
}

function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

/** Keep the Responses bridge alive during every awaited phase of a browser turn. */
export const CHATGPT_WEB_ADAPTER_HEARTBEAT_MS = 10_000;

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: {
    broker?: TurnBrokerOwner;
    zeroRiskManualControl?: ChatGptZeroRiskManualControl;
    codexHome?: string;
  } = {},
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const preparedContinuity = new WeakMap<CodexParsedRequest, PreparedContinuityRequest>();
  const negotiatedTaskUpdates = new WeakSet<CodexParsedRequest>();
  const broker = dependencies.broker ?? TurnBroker.forSocket(brokerSocketPath(provider));
  const zeroRiskManualControl = dependencies.zeroRiskManualControl ?? launcherZeroRiskManualControl;
  const structuredBroker = broker instanceof TurnBroker ? broker : undefined;
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const experimentalSkillAttachments = provider.chatgptWeb?.experimentalSkillAttachments;
  if (experimentalSkillAttachments !== undefined && typeof experimentalSkillAttachments !== "boolean") {
    throw new Error("ChatGPT skill attachments preference must be a boolean");
  }
  if (experimentalSkillAttachments && provider.chatgptWeb?.browserInteractionMode === "manual") {
    throw new Error("Skills as files is unavailable in Zero Risk mode");
  }
  const experimentalBiggerContext = provider.chatgptWeb?.experimentalBiggerContext;
  if (experimentalBiggerContext !== undefined && typeof experimentalBiggerContext !== "boolean") {
    throw new Error("ChatGPT Bigger Context preference must be a boolean");
  }
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    extraHighAvailable: provider.chatgptWeb?.extraHighAvailable === true,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const manualInteraction = provider.chatgptWeb?.browserInteractionMode === "manual";
  const zeroRiskRequireSentConfirmation = provider.chatgptWeb?.zeroRiskRequireSentConfirmation !== false;
  if (provider.chatgptWeb?.zeroRiskRequireSentConfirmation !== undefined
    && typeof provider.chatgptWeb.zeroRiskRequireSentConfirmation !== "boolean") {
    throw new Error("Zero Risk Sent confirmation preference must be a boolean");
  }
  const toolAuthorityMode = provider.chatgptWeb?.toolAuthorityMode ?? "verified-environment";
  const freshConversationPerTurn = provider.chatgptWeb?.experimentalFreshConversationPerTurn === true;
  if (provider.chatgptWeb?.experimentalFreshConversationPerTurn !== undefined
    && typeof provider.chatgptWeb.experimentalFreshConversationPerTurn !== "boolean") {
    throw new Error("ChatGPT fresh conversation preference must be a boolean");
  }
  if (freshConversationPerTurn && manualInteraction) {
    throw new Error("Fresh browser conversations per turn is available only in automatic mode");
  }
  const executionNamespace = chatGptWebExecutionNamespace(provider);
  const retainedLauncherDescriptor = provider.chatgptWeb?.browserHost === "launcher"
    && provider.chatgptWeb.browserHostDescriptorPath
      ? resolve(expandUserPath(provider.chatgptWeb.browserHostDescriptorPath))
      : undefined;
  if (manualInteraction) {
    if (!configuredCapabilities.localToolsEnabled) {
      throw new Error("ChatGPT Zero Risk requires the Full Codex harness");
    }
    if (!retainedLauncherDescriptor) {
      throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
    }
  }
  const environmentStore = toolAuthorityMode === "verified-environment"
    ? new ChatGptThreadEnvironmentStore(
      provider.chatgptWeb?.threadEnvironmentStatePath
        ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
        : undefined,
      Date.now,
      dependencies.codexHome,
    )
    : undefined;
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(
    provider.chatgptWeb?.lunaCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
      : undefined,
  );
  const currentUsageInput = (parsed: CodexParsedRequest): CodexParsedRequest => (
    parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !parsed._compactionRequest
      ? lunaCheckpointStore.apply(parsed).parsed
      : parsed
  );
  let preparedEnvironment: {
    parsed: CodexParsedRequest;
    environment: ChatGptTurnCapability;
  } | undefined;
  const resolveTrustedEnvironment = async (
    parsed: CodexParsedRequest,
    abortSignal?: AbortSignal,
  ): Promise<ReturnType<typeof extractChatGptTurnEnvironment>> => {
    const resolution: ChatGptEnvironmentResolutionDiagnostics = {};
    try {
      if (!environmentStore) throw new Error("Verified ChatGPT environment store is unavailable");
      return await environmentStore.resolveWithRolloutPublicationRetry(parsed, resolution, abortSignal);
    } catch (error) {
      const identity = extractChatGptTurnIdentity(parsed);
      const failure = trustedEnvironmentFailureDetails(error);
      const diagnostics = {
        request_fingerprint: trustedEnvironmentRequestFingerprint(parsed),
        ...trustedEnvironmentRequestDetails(parsed),
        ...resolution,
      };
      console.warn(
        `[chatgpt-web] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ? "present" : "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length}, error_type=${failure.errorType}, reason=${failure.reason}, error_code=${failure.errorCode ?? "none"}, ${Object.entries(diagnostics).map(([key, value]) => `${key}=${value}`).join(", ")})`,
      );
      throw error;
    }
  };
  const resolveToolAuthority = async (
    parsed: CodexParsedRequest,
    abortSignal?: AbortSignal,
  ): Promise<ChatGptTurnCapability> => (
    toolAuthorityMode === "delegated"
      ? extractChatGptDelegatedTurnCapability(parsed)
      : resolveTrustedEnvironment(parsed, abortSignal)
  );
  const prepareTrustedEnvironment = async (
    parsed: CodexParsedRequest,
    abortSignal?: AbortSignal,
  ): Promise<void> => {
    bindContinuityRequestScope(parsed, executionNamespace);
    preparedEnvironment = undefined;
    const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
    if (manualRequest !== manualInteraction) return;
    const turnCapabilities = parsed._compactionRequest && !manualRequest
      ? { ...configuredCapabilities, localToolsEnabled: false }
      : configuredCapabilities;
    const mode = manualRequest
      ? { localTools: true }
      : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    // Preserve runTurn's deterministic validation order before accepting trusted authority.
    if (!parsed._compactionRequest) createChatGptStructuredOutputValidator(parsed.options.outputFormat);
    const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
    if (chatGptWebTurnRetryPolicy.exhaustedError(retryKey) || !mode.localTools) return;
    preparedEnvironment = { parsed, environment: await resolveToolAuthority(parsed, abortSignal) };
  };

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ChatGptTurnCapability | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
    hooks: { onCompactionProgress?: () => void } = {},
  ): ChatGptTurnRuntime => {
    const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
    if (manualRequest !== manualInteraction) {
      throw new Error(
        manualInteraction
          ? "ChatGPT Zero Risk requires the Zero Risk Web model route"
          : "The Zero Risk Web model route requires ChatGPT Zero Risk interaction mode",
      );
    }
    const mode = manualRequest
      ? { localTools: true }
      : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const identity = extractChatGptTurnIdentity(parsed);
    const taskUpdates: NonNullable<ChatGptTurnRuntime["taskUpdates"]> | undefined = negotiatedTaskUpdates.has(parsed)
      ? { protocolVersion: 1 } : undefined;
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    const checkpointInput = captureLunaCheckpoint
      ? lunaCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    const continuity = preparedContinuity.get(parsed);
    if (parsed._conversationPolicy === "continuity-first" && !continuity) throw continuityError("continuity_source_unproven");
    const continuityClaim = continuity ? beginContinuityResponse(continuity) : undefined;
    let continuityLease: ContinuityLease | undefined;
    const acceptContinuityLease = (lease: unknown): void => {
      continuityLease = acceptContinuityResponseLease(continuity!, traceId, lease);
    };
    const loseContinuity = (): void => {
      if (!continuity) return;
      try { continuity.bindings.lose(continuity.binding, continuity.executionKey); }
      catch { console.error("[chatgpt-web] continuity owner is lost and its registration could not be updated"); }
    };
    const promptInput = continuity?.input ?? checkpointInput.parsed;
    const conversationKey = continuity?.conversationKey ?? (!parsed._compactionRequest
      && !freshConversationPerTurn
      && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
      && mode.localTools
      && retainedLauncherDescriptor
      ? chatGptConversationKey(checkpointInput.parsed, executionNamespace)
      : undefined);
    const resumeInput = continuity
      ? continuityClaim?.expected ? promptInput : undefined
      : conversationKey
      ? retainedConversationResumeRequest(checkpointInput.parsed)
      : undefined;
    const retainConversation = conversationKey !== undefined;
    const releaseRetainedConversation = conversationKey && retainedLauncherDescriptor
      ? async () => {
        if (continuity && !continuityLease) return;
        if (continuity) await releaseLauncherRetainedConversation(retainedLauncherDescriptor, conversationKey, undefined, continuityLease);
        else await releaseLauncherRetainedConversation(retainedLauncherDescriptor, conversationKey);
      }
      : undefined;
    const compileOptionsFor = (input: CodexParsedRequest) => {
      if (manualRequest) return {};
      const experimentalMultipartParts = experimentalBiggerContext
        ? resolveBiggerContextMultipartParts(input, turnCapabilities, experimentalSkillAttachments)
        : undefined;
      return {
        captureLunaCheckpoint,
        experimentalSkillAttachments,
        ...(taskUpdates ? { taskUpdateProtocol: 1 as const } : {}),
        ...(continuityClaim?.expected ? { retainedContinuity: true as const } : {}),
        ...(experimentalMultipartParts !== undefined
          ? { experimentalMultipartParts }
          : {}),
      };
    };
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    const finalizeContinuity = (browser: Promise<string>): Promise<string> => !continuity ? browser : browser.then(
      async answer => {
        try { await finishContinuityResponse(continuity); }
        catch {
          // The accepted ordinary answer remains authoritative. Only continued page ownership is
          // lost; a later request must fail closed rather than replace this result or recreate it.
          loseContinuity();
        }
        return answer;
      },
      error => {
        if (error instanceof ChatGptWebAdapterError && error.code === "continuity_resource_capacity"
          && continuity.binding.state === "creating"
          && continuity.binding.initialExecutionKey === continuity.executionKey
          && !continuity.binding.lease && !continuityLease) {
          throw error;
        }
        loseContinuity();
        if (error instanceof ChatGptWebAdapterError && !error.retryable) throw error;
        throw continuityError("continuity_session_lost");
      },
    );
    if (continuity?.finalReplaySource) {
      const outcome = continuity.finalReplaySource.settledOutcome();
      if (outcome?.type !== "final" || !continuity.expected) throw continuityError("continuity_source_unproven");
      continuityLease = { ...continuity.expected };
      const text = new ChatGptTextFeed();
      text.push(outcome.answer);
      const recordedPrelude = continuity.finalReplaySource.eventsForFinalReplay();
      if (recordedPrelude.length > 0) text.drain();
      continuity.bindings.responseReady(continuity.binding, continuity.executionKey, false);
      return {
        mode: "read-only", browser: Promise.resolve(outcome.answer), physicalSettlement: Promise.resolve(),
        usageInput: parsed, text, trace: new ChatGptTraceFeed(), conversationKey,
        continuityBinding: continuity.binding,
        submission: { phase: "accepted" }, releaseRetainedConversation,
        cancel: () => { loseContinuity(); void releaseRetainedConversation?.().catch(() => {}); },
      };
    }
    const browserAbort = new AbortController();
    const waitingObservationStop = new AbortController();
    let browserOwnerSettled = false;
    const trackBrowserOwner = (browser: Promise<string>): Promise<string> => browser.finally(() => {
      browserOwnerSettled = true;
      waitingObservationStop.abort();
    });
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    const observedCapabilityTokens = new Set<string>();
    const observeCapabilityRetirement = (
      turnToken: string,
      externalProgress: ChatGptExternalTurnProgress,
    ): void => {
      if (observedCapabilityTokens.has(turnToken)) return;
      observedCapabilityTokens.add(turnToken);
      const observeSignal = AbortSignal.any([browserAbort.signal, waitingObservationStop.signal]);
      const observeFailure = (error: unknown): void => {
        if (observeSignal.aborted || browserOwnerSettled) return;
        const failure = error instanceof NativeOperationError
          ? new ChatGptWebAdapterError(error.message, {
            status: 502, errorType: "server_error", code: error.code, retryable: false, cause: error,
          })
          : new ChatGptWebAdapterError("The Native waiting observer is unavailable", {
            status: 502, errorType: "server_error", code: "codex_tool_infrastructure_failure", retryable: false,
          });
        externalProgress.retire(failure);
        if (!browserAbort.signal.aborted) browserAbort.abort(failure);
      };
      // This owner subscription outlives individual Responses requests, so a blocked Native
      // input call does not prevent authenticated wait activity from reaching the browser.
      void (async () => {
        let revision = 0;
        while (!observeSignal.aborted) {
          const snapshot = await broker.waitForNativeWaiting(turnToken, revision, observeSignal);
          if (observeSignal.aborted) return;
          revision = snapshot.revision;
          externalProgress.recordNativeWaiting(snapshot);
        }
      })().catch(observeFailure);
      if (taskUpdates) {
        if (!broker.waitForTaskUpdateState || !broker.taskUpdateState) throw taskUpdateSourceError(
          "task_update_upgrade_required", "The negotiated task update observer protocol is unavailable.");
        void (async () => {
          const initial = await broker.taskUpdateState!(turnToken);
          if (!initial?.acknowledgementDirectory) throw taskUpdateSourceError("task_update_upgrade_required", "The task update capability lacks its acknowledgment publication source.");
          mirrorLatestTaskUpdateState(externalProgress, initial);
          let revision = 0;
          while (!observeSignal.aborted) {
            const snapshot = await broker.waitForTaskUpdateState!(turnToken, revision, observeSignal);
            if (observeSignal.aborted) return;
            revision = snapshot.revision;
            mirrorLatestTaskUpdateState(externalProgress, snapshot.state);
          }
        })().catch(observeFailure);
      }
      void broker.waitForRetirement(turnToken).then(
        failure => {
          const retirement = failure
            ? chatGptToolTimeoutError(failure.tool, failure.timeoutMs)
            : new Error("Codex Native retired the turn binding before its tool work completed");
          externalProgress.retire(retirement);
          if (!browserOwnerSettled && !browserAbort.signal.aborted) browserAbort.abort(retirement);
        },
        observeFailure,
      );
    };
    const submission: NonNullable<ChatGptTurnRuntime["submission"]> = { phase: "prepared" };
    // A canonical compaction request is side-effect free and remains safe to rebuild after an
    // ambiguous browser send. Normal task prompts must never be replayed after Send activation.
    const submissionLifecycle = {
      ...(!parsed._compactionRequest ? {
        onSendActivated: () => { submission.phase = "send_activated" as const; },
      } : {}),
      onSubmitted: () => {
        if (!parsed._compactionRequest) submission.phase = "accepted";
        hooks.onCompactionProgress?.();
      },
    };
    const multipartProgressLifecycle = hooks.onCompactionProgress
      ? { onMultipartStageAcknowledged: hooks.onCompactionProgress }
      : {};
    if (manualRequest) {
      if (!environment) throw new Error("ChatGPT Zero Risk requires current Codex tool authority");
      if (!retainedLauncherDescriptor) throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
      const token = deferred<string>();
      const externalProgress = new ChatGptExternalTurnProgress();
      const surfaceNonce = randomBytes(32).toString("base64url");
      const owner: LauncherManualTurnOwner = { traceId, helperPid: process.pid };
      let tokenSettled = false;
      let activeToken: string | undefined;
      let launcherStarted = false;
      let launcherEnded = false;
      const finishLauncher = async (status: LauncherManualTurnEnd["status"]): Promise<void> => {
        if (!launcherStarted || launcherEnded) return;
        await zeroRiskManualControl.end(retainedLauncherDescriptor, {
          ...owner,
          status,
          ...(status === "completed" && retainConversation ? { retain: true } : {}),
        });
        launcherEnded = true;
      };
      const runManual = async (): Promise<string> => {
        try {
          activeToken = await broker.registerSafe(
            environment,
            surfaceNonce,
            undefined,
            traceId,
            { requireSentConfirmation: zeroRiskRequireSentConfirmation,
              ...(taskUpdates ? { taskUpdateProtocol: 1 as const } : {}) },
          );
          observeCapabilityRetirement(activeToken, externalProgress);
          const compiled = compileChatGptWebPrompt(
            promptInput,
            turnCapabilities,
            activeToken,
            { manualControl: true, ...(taskUpdates ? { taskUpdateProtocol: 1 } : {}),
              ...(continuityClaim?.expected ? { retainedContinuity: true } : {}) },
          );
          const resumeCompiled = resumeInput
            ? compileChatGptWebPrompt(
              resumeInput,
              turnCapabilities,
              activeToken,
              { manualControl: true, ...(taskUpdates ? { taskUpdateProtocol: 1 } : {}),
                ...(continuityClaim?.expected ? { retainedContinuity: true } : {}) },
            )
            : undefined;
          if (continuity) assertContinuityCompiledInput(compiled, promptInput, turnCapabilities);
          for (const candidate of [compiled, resumeCompiled]) {
            if (!candidate) continue;
            if (candidate.multipart) {
              throw new ChatGptWebAdapterError("ChatGPT Zero Risk does not support multipart browser transport", {
                status: 409,
                errorType: "invalid_request_error",
                code: "manual_multipart_unsupported",
                retryable: false,
              });
            }
          }
          const manualLease = await zeroRiskManualControl.start(retainedLauncherDescriptor, {
            ...owner,
            prompt: compiled.text,
            sentConfirmationRequired: zeroRiskRequireSentConfirmation,
            ...(resumeCompiled ? { resumePrompt: resumeCompiled.text } : {}),
            ...(conversationKey ? { conversationKey } : {}),
            ...(continuityClaim ? {
              continuity: continuityClaim,
              ...(continuityClaim.expected ? { requireRetainedConversation: true } : {}),
            } : {}),
            ...(parsed._compactionRequest ? { compaction: true as const } : {}),
          });
          launcherStarted = true;
          if (continuity) acceptContinuityLease((manualLease as { continuity?: unknown } | undefined)?.continuity);
          // Do not expose the broker request id to the outer harness until Launcher has captured
          // and accepted the same per-turn Sent policy used by the broker.
          tokenSettled = true;
          token.resolve(activeToken);
          if (!parsed._compactionRequest) {
            trace.push({
              kind: "commentary",
              text: zeroRiskRequireSentConfirmation
                ? "> **Action required in Zero Risk**\n>\n> Open the launcher, copy and paste the prompt into ChatGPT, add any images yourself because Zero Risk cannot transfer them, select the plugin shown in the launcher and the model you want, send the prompt, then confirm it was sent in the launcher."
                : "> **Action required in Zero Risk**\n>\n> Open the launcher, copy and paste the prompt into ChatGPT, add any images yourself because Zero Risk cannot transfer them, select the plugin shown in the launcher and the model you want, then send the prompt. The connector will confirm this turn automatically.",
            });
          }
          if (zeroRiskRequireSentConfirmation) {
            await zeroRiskManualControl.waitSent(retainedLauncherDescriptor, owner, {
              abortSignal: browserAbort.signal,
            });
            await broker.confirmSafeTurnSent(activeToken, surfaceNonce);
            submission.phase = "accepted";
            if (!parsed._compactionRequest) trace.push({
              kind: "commentary",
              text: "> **Waiting for ChatGPT**\n>\n> The prompt is marked `Sent`. Waiting for the selected ChatGPT plugin to connect.",
            });
          }
          const terminalAbort = new AbortController();
          const abortTerminal = () => terminalAbort.abort();
          browserAbort.signal.addEventListener("abort", abortTerminal, { once: true });
          const terminalFailure = zeroRiskManualControl.waitTerminal(
            retainedLauncherDescriptor,
            owner,
            { abortSignal: terminalAbort.signal },
          ).then(observed => Promise.reject(safeManualTerminalError(observed.status)))
            .catch(error => terminalAbort.signal.aborted
              ? new Promise<never>(() => {})
              : Promise.reject(error));
          let answer: string;
          try {
            await Promise.race([
              broker.waitForSafeStart(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
            submission.phase = "accepted";
            await zeroRiskManualControl.markStarted(retainedLauncherDescriptor, owner);
            if (!parsed._compactionRequest) trace.push({
              kind: "commentary",
              text: "> **Zero Risk connected**\n>\n> The Zero Risk plugin is connected. ChatGPT is now working through the native Codex harness; progress remains visible in the launcher.",
            });
            answer = await Promise.race([
              broker.waitForSafeCompletion(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
          } finally {
            terminalAbort.abort();
            browserAbort.signal.removeEventListener("abort", abortTerminal);
          }
          if (taskUpdates) {
            const receipt = await broker.taskOutputReceipt!(activeToken);
            if (!receipt) throw taskUpdateSourceError("task_update_output_unproven", "Zero Risk completion did not retain its task version receipt.");
            taskUpdates.outputReceipt = receipt;
            text.push(answer, { expectedDriverGeneration: receipt.driverGeneration, taskRevision: receipt.taskRevision });
          } else text.push(answer);
          try {
            await finishLauncher("completed");
          } catch (controlError) {
            loseContinuity();
            // The broker result is already authoritative. A launcher acknowledgement failure may
            // leave UI cleanup pending, but it must not replace a completed Codex answer with an
            // error or trigger a contradictory failed terminal mutation.
            console.error(
              `[chatgpt-web] completed Zero Risk turn but could not confirm launcher cleanup: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          return answer;
        } catch (error) {
          const normalized = safeManualAdapterError(error);
          // Capture the causal state before our own cleanup revokes the broker capability. The
          // retirement observer also aborts browserAbort, but that self-induced abort must not turn
          // an ordinary launcher/runtime failure into a user cancellation.
          const externallyAborted = browserAbort.signal.aborted;
          // Before the Launcher policy handshake is published, this worker owns cleanup. After
          // publication, the turn session owns the same capability and must observe this browser
          // failure before revoking it; otherwise cleanup can replace the causal Launcher error
          // with an "invalid or expired" broker error in the response observer.
          if (activeToken && !tokenSettled) {
            await Promise.resolve((broker.revokeTrusted ?? broker.revoke).call(broker, activeToken, normalized)).catch(() => {});
          }
          try {
            await finishLauncher(externallyAborted ? "aborted" : "failed");
          } catch (controlError) {
            console.error(
              `[chatgpt-web] failed to release Zero Risk launcher turn: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          throw normalized;
        }
      };
      const browserTurn = cancellableBrowserTurn(trackBrowserOwner(finalizeContinuity(runManual())), browserAbort);
      void browserTurn.browser.catch(error => {
        if (tokenSettled) return;
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      });
      return {
        mode: "tools",
        token: token.promise,
        externalProgress,
        ...(taskUpdates ? { taskUpdates } : {}),
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: checkpointInput.parsed,
        manualControl: { surfaceNonce },
        ...(continuity ? { continuityBinding: continuity.binding } : {}),
        ...(conversationKey ? { conversationKey } : {}),
        ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
        retireCapability: async () => {
          if (activeToken) await (broker.revokeTrusted ?? broker.revoke).call(broker, activeToken);
        },
        submission,
        cancel: (reason?: Error) => {
          loseContinuity();
          browserTurn.cancel(reason);
          if (continuity) void browserTurn.physicalSettlement.then(() => releaseRetainedConversation?.()).catch(() => {});
          if (activeToken) {
            void Promise.resolve((broker.revokeTrusted ?? broker.revoke).call(broker, activeToken, reason)).catch(error => {
              console.error(`[chatgpt-web] failed to revoke cancelled Zero Risk request: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        },
      };
    }
    if (!mode.localTools) {
      const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
        capabilities: turnCapabilities,
        prepare: async () => ({
          ...compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            undefined,
            compileOptionsFor(checkpointInput.parsed),
          ),
          release: () => {},
        }),
        abortSignal: browserAbort.signal,
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        ...submissionLifecycle,
        ...multipartProgressLifecycle,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      })), browserAbort);
      return {
        mode: "read-only",
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: checkpointInput.parsed,
        submission,
        cancel: browserTurn.cancel,
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires current Codex tool authority");
    const token = deferred<string>();
    const externalProgress = new ChatGptExternalTurnProgress();
    let tokenSettled = false;
    let activeToken: string | undefined;
    const bufferedTextAdmissions = new Map<string, Promise<void>>();
    const candidateKey = (candidate: TaskUpdateOwnerContext): string =>
      `${candidate.expectedDriverGeneration}:${candidate.taskRevision}`;
    if (taskUpdates && parsed.options.outputFormat?.strict) {
      taskUpdates.bufferedTextAdmission = candidate => bufferedTextAdmissions.get(candidateKey(candidate));
    }
    const observeFinalText = (delta: string, candidate?: TaskUpdateOwnerContext): void => {
      if (delta && candidate && taskUpdates?.bufferedTextAdmission) {
        const captured = { ...candidate };
        const key = candidateKey(captured);
        if (!bufferedTextAdmissions.has(key)) {
          let admission: Promise<void>;
          try {
            const receipt = taskUpdates.outputReceipt;
            if (receipt) {
              if (captured.acknowledgedRevision !== undefined && captured.acknowledgedRevision !== captured.taskRevision) {
                throw taskUpdateSourceError("task_update_unacknowledged", "The final text was observed before its task revision was acknowledged.");
              }
              if (receipt.driverGeneration !== captured.expectedDriverGeneration || receipt.taskRevision !== captured.taskRevision) {
                throw taskUpdateSourceError("task_update_output_stale", "Final text does not belong to the committed task version.");
              }
              admission = Promise.resolve();
            } else {
              if (!activeToken || !broker.checkFinalOutputCandidate) throw taskUpdateSourceError(
                "task_update_upgrade_required", "The buffered final output admission protocol is unavailable.");
              if (captured.acknowledgedRevision === undefined) {
                const observed = externalProgress.snapshot().taskUpdates;
                if (!observed || observed.acceptedRevision !== captured.taskRevision
                  || observed.driverGeneration !== captured.expectedDriverGeneration) throw taskUpdateSourceError(
                  "task_update_output_unproven", "The final text lacks its observed acknowledgment head.");
                captured.acknowledgedRevision = observedTaskAcknowledgement(observed);
              }
              // Start the check in the callback, before queued text can be consumed after a late
              // ACK. Retain its observed ACK head as well: an IPC request can reach Broker later.
              // Admission is separate from the eventual output/completion lock.
              admission = Promise.resolve(broker.checkFinalOutputCandidate(activeToken, captured));
            }
          } catch (error) { admission = Promise.reject(error); }
          void admission.catch(() => {});
          bufferedTextAdmissions.set(key, admission);
        }
      }
      text.push(delta, candidate);
    };
    const prepareWith = async (input: CodexParsedRequest) => {
      const turnToken = activeToken ?? await broker.register(
        environment,
        timeoutMs === undefined ? undefined : timeoutMs + 60_000,
        traceId,
        taskUpdates ? { taskUpdateProtocol: 1 } : undefined,
      );
      activeToken = turnToken;
      try {
        const compiled = compileChatGptWebPrompt(
          input,
          turnCapabilities,
          turnToken,
          compileOptionsFor(input),
        );
        if (continuity) assertContinuityCompiledInput(compiled, input, turnCapabilities);
        // Publish only after preparation succeeds: otherwise its failure revokes the token
        // before the response observer uses it and masks the cause as an expired capability.
        observeCapabilityRetirement(turnToken, externalProgress);
        if (!tokenSettled) {
          tokenSettled = true;
          token.resolve(turnToken);
        }
        return { ...compiled, release: () => {} };
      } catch (error) {
        await (broker.revokeTrusted ?? broker.revoke).call(broker, turnToken);
        activeToken = undefined;
        throw error;
      }
    };
    const browserTurn = cancellableBrowserTurn(trackBrowserOwner(finalizeContinuity(finalizeCheckpoint(worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
      capabilities: turnCapabilities,
      prepare: () => prepareWith(promptInput),
      ...(resumeInput ? { prepareResume: () => prepareWith(resumeInput) } : {}),
      ...(retainConversation ? { retainConversation: true, conversationKey } : {}),
      ...(continuityClaim ? {
        continuity: continuityClaim,
        onContinuityLease: acceptContinuityLease,
        ...(continuityClaim.expected ? { requireRetainedConversation: true } : {}),
      } : {}),
      abortSignal: browserAbort.signal,
      ...(parsed._compactionRequest ? { compaction: true } : {}),
      ...submissionLifecycle,
      ...multipartProgressLifecycle,
      onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
      onTextDelta: observeFinalText,
      externalProgress,
      ...(taskUpdates ? { taskUpdateProtocol: 1 as const } : {}),
      completionFence: {
        begin: async candidate => {
          if (taskUpdates && !candidate) throw taskUpdateSourceError("task_update_output_unproven", "The completion candidate lacks its captured task version.");
          if (candidate) await taskUpdates?.bufferedTextAdmission?.(candidate);
          return broker.beginCompletionFence(await token.promise, candidate);
        },
        commit: async (revision, candidate) => {
          if (taskUpdates && !candidate) throw taskUpdateSourceError("task_update_output_unproven", "The completion candidate lacks its captured task version.");
          if (candidate) await taskUpdates?.bufferedTextAdmission?.(candidate);
          const turnToken = await token.promise;
          const committed = await broker.commitCompletionFence(turnToken, revision, candidate);
          if (committed && taskUpdates) {
            const receipt = await broker.taskOutputReceipt!(turnToken);
            if (!receipt) throw taskUpdateSourceError("task_update_output_unproven", "The completion commit did not retain its task version receipt.");
            taskUpdates.outputReceipt = receipt;
          }
          return committed;
        },
      },
      ...(captureLunaCheckpoint ? {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: captureCheckpoint,
      } : {}),
    })))), browserAbort);
    void browserTurn.browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      token: token.promise,
      externalProgress,
      ...(taskUpdates ? { taskUpdates } : {}),
      browser: browserTurn.browser,
      physicalSettlement: browserTurn.physicalSettlement,
      trace,
      text,
      usageInput: checkpointInput.parsed,
      ...(continuity ? { continuityBinding: continuity.binding } : {}),
      ...(conversationKey ? { conversationKey } : {}),
      ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
      retireCapability: async () => {
        if (activeToken) await (broker.revokeTrusted ?? broker.revoke).call(broker, activeToken);
      },
      submission,
      cancel: (reason?: Error) => {
        loseContinuity();
        browserTurn.cancel(reason);
        if (continuity) void browserTurn.physicalSettlement.then(() => releaseRetainedConversation?.()).catch(() => {});
        if (activeToken) {
          void Promise.resolve((broker.revokeTrusted ?? broker.revoke).call(broker, activeToken, reason)).catch(error => {
            console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
    };
  };

  return {
    name: "chatgpt-web",
    async preflight(parsed, incoming) {
      await prepareTrustedEnvironment(parsed, incoming.abortSignal);
      if (parsed._conversationPolicy === "continuity-first") {
        preparedContinuity.set(parsed, await prepareContinuityRequest(parsed, provider, executionNamespace, configuredCapabilities, worker, incoming.abortSignal));
      } else if (isChatGptWebZeroRiskBackendModel(parsed.modelId) === manualInteraction) {
        incoming.abortSignal?.throwIfAborted();
        await leaveContinuityMode(provider.chatgptWeb?.continuityStateDirectory, extractChatGptTurnIdentity(parsed).threadId);
      }
    },
    async runTurn(parsed, incoming, emit) {
      bindContinuityRequestScope(parsed, executionNamespace);
      const runChatGptWebTurn = async (): Promise<void> => {
        if (parsed._conversationPolicy === "continuity-first") incoming.abortSignal?.throwIfAborted();
        const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
        if (manualRequest !== manualInteraction) {
          emit({
            type: "error",
            message: manualInteraction
              ? "ChatGPT Zero Risk requires the Zero Risk Web model route."
              : "The Zero Risk Web model route is unavailable while automatic browser interaction is enabled.",
            status: 409,
            errorType: "invalid_request_error",
            code: "browser_interaction_mode_mismatch",
            retryable: false,
          });
          return;
        }
        const turnCapabilities = parsed._compactionRequest && !manualRequest
          ? { ...configuredCapabilities, localToolsEnabled: false }
          : configuredCapabilities;
        const mode = manualRequest
          ? { localTools: true }
          : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
        const structuredOutputValidator = parsed._compactionRequest
          ? undefined
          : createChatGptStructuredOutputValidator(parsed.options.outputFormat);
        const bufferStructuredOutput = structuredOutputValidator !== undefined;
        const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
        const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
        if (exhaustedRetry) {
          emit({
            type: "error",
            message: exhaustedRetry.message,
            status: exhaustedRetry.status,
            errorType: exhaustedRetry.errorType,
            code: exhaustedRetry.code,
            retryable: false,
          });
          return;
        }
        let environment: ChatGptTurnCapability | undefined;
        if (mode.localTools) {
          if (preparedEnvironment?.parsed === parsed) {
            environment = preparedEnvironment.environment;
            preparedEnvironment = undefined;
          } else {
            environment = await resolveToolAuthority(parsed, incoming.abortSignal);
          }
        }
        if (parsed._conversationPolicy === "continuity-first" && !preparedContinuity.has(parsed)) {
          preparedContinuity.set(parsed, await prepareContinuityRequest(parsed, provider, executionNamespace, configuredCapabilities, worker, incoming.abortSignal));
        }
        if (parsed._conversationPolicy === "continuity-first" && environment) {
          environment = { ...environment, tools: parsed.context.tools ?? [] };
        }
        if (parsed._conversationPolicy !== "continuity-first") {
          incoming.abortSignal?.throwIfAborted();
          await leaveContinuityMode(provider.chatgptWeb?.continuityStateDirectory, extractChatGptTurnIdentity(parsed).threadId);
        }
        if (parsed._conversationPolicy === "continuity-first" && parsed._compactionRequest) {
          const prepared = preparedContinuity.get(parsed)!;
          emit({ type: "heartbeat" });
          const shared = runContinuityCompaction(parsed, prepared, worker, broker, configuredCapabilities,
            executionNamespace, timeoutMs, incoming.onProgress);
          const summary = await withAbort(shared, incoming.abortSignal);
          await assertContinuityCompactionResult(prepared);
          emit({ type: "text_delta", text: summary, phase: "final_answer" });
          emitBrowserCompletion({ type: "final", answer: summary },
            estimateChatGptWebUsage(parsed, { answer: summary, reasoning: [] }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments), emit);
          chatGptWebTurnRetryPolicy.clear(retryKey);
          return;
        }
        if (parsed._compactionRequest) {
          const structuredCompactionRequired = parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
            && configuredCapabilities.localToolsEnabled;
          if (structuredCompactionRequired
            && (!retainedLauncherDescriptor || (!manualRequest && !structuredBroker))) {
            emit({
              type: "error",
              message: manualRequest
                ? "Zero Risk could not resume the active ChatGPT conversation for context handoff. Retry the task from the Launcher."
                : "ChatGPT could not resume the active conversation for context handoff. Retry the task.",
              status: 409,
              errorType: "invalid_request_error",
              code: "compaction_control_unavailable",
              retryable: false,
            });
            return;
          }
          if (structuredCompactionRequired) {
            const compactionExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
            const delegatedSourceExecutionKey = toolAuthorityMode === "delegated"
              ? chatGptDelegatedCompactionSourceExecutionKey(parsed)
              : undefined;
            const compactedSourceExecutionKey = toolAuthorityMode === "delegated"
              ? delegatedSourceExecutionKey
                ? `${executionNamespace}:${delegatedSourceExecutionKey}`
                : undefined
              : `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
            const delegatedSourceRevision = toolAuthorityMode === "delegated"
              ? (() => {
                try { return extractChatGptCompactionSourceRevision(parsed); }
                catch { return undefined; }
              })()
              : undefined;
            const handoffTraceId = createHash("sha256")
              .update(`${compactionExecutionKey}:handoff`)
              .digest("hex")
              .slice(0, 12);
            const compactionTraceId = createHash("sha256")
              .update(compactionExecutionKey)
              .digest("hex")
              .slice(0, 12);
            const freshCompactionTraceId = `${handoffTraceId}_${freshConversationPerTurn ? "fresh" : "fallback"}`;
            const compactionNativeIdentity = extractChatGptTurnIdentity(parsed);
            let sharedCompaction = existingStructuredCompactionRun<StructuredCompactionResult>(compactionExecutionKey);
            if (!sharedCompaction) {
              sharedCompaction = runStructuredCompactionOnce(
                compactionExecutionKey,
                {
                  ownerKey: `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`,
                  traceIds: [
                    compactionTraceId,
                    handoffTraceId,
                    freshCompactionTraceId,
                  ],
                  ...(compactionNativeIdentity.threadId
                    ? { nativeThreadId: compactionNativeIdentity.threadId }
                    : {}),
                  ...(compactionNativeIdentity.turnId
                    ? { nativeTurnId: compactionNativeIdentity.turnId }
                    : {}),
                },
                async (operatorSignal, retainOwnershipUntil) => {
                  const handoffTimeoutMs = Math.min(
                    timeoutMs ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                    MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                  );
                  const handoffDeadline = new AbortController();
                  const handoffTimeoutError = new ChatGptWebAdapterError(
                    `ChatGPT compaction did not fully settle within ${handoffTimeoutMs}ms`,
                    {
                      status: 409,
                      errorType: "invalid_request_error",
                      code: "compaction_handoff_timeout",
                      retryable: false,
                    },
                  );
                  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
                  let handoffPhase = "source_settlement";
                  const armHandoffDeadline = (): void => {
                    if (handoffDeadline.signal.aborted) return;
                    if (handoffTimer) clearTimeout(handoffTimer);
                    handoffTimer = setTimeout(
                      () => {
                        console.warn(`[chatgpt-web] compaction_timeout ${JSON.stringify({
                          traceId: compactionTraceId, phase: handoffPhase, timeoutMs: handoffTimeoutMs,
                        })}`);
                        handoffDeadline.abort(handoffTimeoutError);
                      },
                      handoffTimeoutMs,
                    );
                    handoffTimer.unref?.();
                  };
                  const reportCompactionProgress = (): void => {
                    armHandoffDeadline();
                    incoming.onProgress?.();
                  };
                  armHandoffDeadline();
                  const operationSignal = AbortSignal.any([operatorSignal, handoffDeadline.signal]);
                  const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
                  let fallbackReason: string | undefined;
                  const runFreshCompaction = async (reason: string): Promise<string> => {
                    handoffPhase = "fresh_compaction";
                    if (freshConversationPerTurn) console.info("[chatgpt-web] compaction uses configured fresh conversation mode");
                    else {
                      fallbackReason = reason;
                      console.warn(`[chatgpt-web] retained compaction fallback=${reason}`);
                    }
                    // Fresh compaction is a bounded phase. Each exact multipart acknowledgement
                    // and the final accepted compact prompt re-arms the five-minute liveness budget;
                    // transport time cannot consume the model-generation window.
                    armHandoffDeadline();
                    const fallbackRuntime = startRuntime(
                      parsed,
                      manualRequest ? environment : undefined,
                      freshCompactionTraceId,
                      turnCapabilities,
                      { onCompactionProgress: reportCompactionProgress },
                    );
                    retainOwnershipUntil(fallbackRuntime.physicalSettlement);
                    try {
                      const rawSummary = await withAbort(fallbackRuntime.browser, operationSignal);
                      await withAbort(fallbackRuntime.physicalSettlement, operationSignal);
                      return canonicalizeCompactionHandoff(parsed, rawSummary);
                    } catch (error) {
                      fallbackRuntime.cancel(error instanceof Error ? error : new Error(String(error)));
                      // The shared owner retains physical settlement independently of this error.
                      // Neither a timeout nor operator cancellation can open a competing trace.
                      throw error;
                    }
                  };
                  let source: ChatGptTurnSession | undefined;
                  let preserveFinalResponse = false;
                  try {
                    if (freshConversationPerTurn) {
                      // Full native history is the compaction input. Release an unfinished
                      // browser/tool owner before rebuilding it, but keep a committed final
                      // replayable if it won the native compaction race.
                      const previous = compactedSourceExecutionKey
                        ? chatGptTurnSessions.findTaskUpdateSource(compactedSourceExecutionKey)
                        : undefined;
                      const settlement = previous?.settledOutcome()?.type === "final"
                        ? previous.physicalSettlement
                        : compactedSourceExecutionKey
                          ? chatGptTurnSessions.retireAndWait(compactedSourceExecutionKey).then(() => {})
                          : Promise.resolve();
                      retainOwnershipUntil(settlement);
                      await withAbort(settlement, operationSignal);
                      const summary = await runFreshCompaction("configured_fresh_conversation");
                      return { summary, path: "fresh" };
                    }
                    // The previous compaction may already have detached the retained head while
                    // its browser/helper is still unwinding. Do not inspect that old epoch or
                    // decide to open a fresh fallback until physical release has completed.
                    if (sourceConversationKey) {
                      await chatGptTurnSessions.waitForConversationRetirement(
                        sourceConversationKey,
                        operationSignal,
                      );
                    }
                    const sourceHead = sourceConversationKey
                      ? chatGptTurnSessions.findConversationHead(sourceConversationKey)
                      : undefined;
                    if (toolAuthorityMode === "delegated") {
                      source = compactedSourceExecutionKey
                        ? chatGptTurnSessions.findTaskUpdateSource(compactedSourceExecutionKey)
                        : undefined;
                      const exactSource = source !== undefined
                        && source === sourceHead
                        && source.nativeThreadId === compactionNativeIdentity.threadId
                        && source.nativeTurnId === delegatedSourceRevision?.turnId;
                      if (!exactSource) {
                        if (sourceConversationKey) {
                          await withAbort(
                            chatGptTurnSessions.retireConversationAndWait(sourceConversationKey),
                            operationSignal,
                          );
                        }
                        const summary = await runFreshCompaction("delegated_source_identity_unavailable");
                        return { summary, path: "fresh", fallbackReason };
                      }
                    } else {
                      source = sourceHead;
                    }
                    if (source?.taskUpdatesEnabled() && (!compactedSourceExecutionKey
                      || chatGptTurnSessions.findTaskUpdateSource(compactedSourceExecutionKey) !== source)) {
                      throw taskUpdateSourceError("task_update_source_stale", "Compaction must address the latest exact accepted instruction source.");
                    }
                    preserveFinalResponse = !source?.isActive()
                      && source?.settledOutcome()?.type === "final";
                    const retainedKey = source?.conversationKey();
                    if (!source || !retainedKey) {
                      const summary = await runFreshCompaction("source_unavailable_before_handoff");
                      return { summary, path: "fresh", fallbackReason };
                    }
                    let rawSummary: string;
                    if (manualRequest && source.isActive() && source.runtime.mode === "tools") {
                      const zeroRiskSummary = await settleActiveZeroRiskCompactionSource(
                        parsed,
                        source,
                        broker,
                        operationSignal,
                        incoming.onProgress,
                      );
                      if (zeroRiskSummary === undefined) {
                        preserveFinalResponse = true;
                        rawSummary = await runFreshCompaction("zero_risk_source_had_no_compaction_boundary");
                      } else {
                        rawSummary = zeroRiskSummary;
                      }
                    } else if (manualRequest) {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      rawSummary = await runFreshCompaction("zero_risk_source_already_completed");
                    } else if (source.isActive() && source.runtime.mode === "tools") {
                      const settlement = await settleActiveCompactionSource(
                        parsed,
                        source,
                        structuredBroker!,
                        operationSignal,
                        incoming.onProgress,
                      );
                      preserveFinalResponse = !settlement.compactionInstructionDelivered;
                      // The previous response has physically settled. Its waiting time must not
                      // consume the independent, bounded request for the retained checkpoint.
                      handoffPhase = "retained_checkpoint";
                      armHandoffDeadline();
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                        incoming.onProgress,
                      );
                    } else {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      handoffPhase = "retained_checkpoint";
                      armHandoffDeadline();
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                        incoming.onProgress,
                      );
                    }
                    const summary = canonicalizeCompactionHandoff(parsed, rawSummary);
                    await withAbort(
                      preserveFinalResponse && compactedSourceExecutionKey
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey),
                      operationSignal,
                    );
                    return {
                      summary,
                      path: fallbackReason ? "fresh" : "retained",
                      ...(fallbackReason ? { fallbackReason } : {}),
                    };
                  } catch (error) {
                    if (error && typeof error === "object" && "code" in error
                      && typeof error.code === "string" && error.code.startsWith("task_update_")) throw error;
                    const retainedKey = source?.conversationKey();
                    if (!retainedKey) throw error;
                    let handoffError = error instanceof Error ? error : new Error(String(error));
                    try {
                      // Operator cancellation ends the logical compaction, but cancel-all must not
                      // acknowledge until the retained browser/helper owner has physically retired.
                      await (preserveFinalResponse && compactedSourceExecutionKey
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source!,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey));
                    } catch (retirementError) {
                      handoffError = new AggregateError(
                        [handoffError, retirementError instanceof Error ? retirementError : new Error(String(retirementError))],
                        "Structured compaction failed and its retained conversation could not be retired",
                      );
                    }
                    if (handoffError instanceof ChatGptWebAdapterError
                      && handoffError.code === "compaction_source_unavailable") {
                      const summary = await runFreshCompaction("source_disappeared_before_handoff");
                      return { summary, path: "fresh", fallbackReason };
                    }
                    throw handoffError;
                  } finally {
                    if (handoffTimer) clearTimeout(handoffTimer);
                  }
                },
              );
            }
            emit({ type: "heartbeat" });
            let compaction: StructuredCompactionResult;
            try {
              compaction = await withAbort(sharedCompaction, incoming.abortSignal);
            } catch (error) {
              if (incoming.abortSignal?.aborted
                && error instanceof DOMException
                && error.name === "AbortError") {
                // The observer detached; the shared exact compaction round continues and remains
                // available to a canonical reconnect without a second browser submission.
                throw error;
              }
              const handoffError = error instanceof Error ? error : new Error(String(error));
              console.error("[chatgpt-web] structured context handoff failed:", handoffError);
              const upstreamError = handoffError instanceof ChatGptWebAdapterError ? handoffError : undefined;
              emit({
                type: "error",
                message: upstreamError?.message ?? "ChatGPT did not complete the context handoff. Retry the task.",
                status: upstreamError?.status ?? 409,
                errorType: upstreamError?.errorType ?? "invalid_request_error",
                code: upstreamError?.code ?? "compaction_handoff_failed",
                // Compaction retry remains an explicit operator decision even when its source
                // failure was retryable; preserve the cause without opening a new retry loop.
                retryable: false,
              });
              return;
            }
            const summary = compaction.summary;
            const responseMetadata = toolAuthorityMode === "delegated" && compaction.path === "fresh"
              ? {
                codex_chatgpt_web_compaction_path: "fresh",
                codex_chatgpt_web_compaction_fallback_reason: compaction.fallbackReason ?? "unspecified",
              }
              : undefined;
            emit({ type: "text_delta", text: summary, phase: "final_answer" });
            emitBrowserCompletion(
              { type: "final", answer: summary },
              estimateChatGptWebUsage(parsed, { answer: summary, reasoning: [] }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
              emit,
              responseMetadata,
            );
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }
          const responseSourceExecutionKey = toolAuthorityMode === "delegated"
            ? chatGptDelegatedCompactionSourceExecutionKey(parsed)
            : chatGptCompactionSourceExecutionKey(parsed);
          if (responseSourceExecutionKey) {
            await chatGptTurnSessions.retireAndWait(
              `${executionNamespace}:${responseSourceExecutionKey}`,
              incoming.abortSignal,
            );
          } else {
            const conversationKey = chatGptConversationKey(parsed, executionNamespace);
            if (conversationKey) {
              await withAbort(
                chatGptTurnSessions.retireConversationAndWait(conversationKey),
                incoming.abortSignal,
              );
            }
          }
        }
        const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
        const ownerKey = `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`;
        const nativeIdentity = extractChatGptTurnIdentity(parsed);
        const nativeTurnId = nativeIdentity.turnId;
        if (!nativeTurnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser ownership");
        const abortedTurnIds = manualRequest ? new Set(priorChatGptAbortedTurnIds(parsed)) : undefined;
        if (abortedTurnIds?.size) {
          chatGptTurnSessions.retireAbortedOwnerTurns(ownerKey, abortedTurnIds, executionKey);
        }
        const traceId = chatGptWebTraceId(provider, parsed);
        const retainedContinuitySession = parsed._conversationPolicy === "continuity-first"
          ? chatGptTurnSessions.find(executionKey)
          : undefined;
        const continuityReplay = retainedContinuitySession
          && retainedContinuitySession.roundCompleted(retainedContinuitySession.continuityRoundKey(parsed))
          ? retainedContinuitySession : undefined;
        const taskExecution = environment ? taskUpdateExecutionIdentity(environment, executionNamespace, parsed) : undefined;
        const existingTaskSession = parsed._conversationPolicy !== "continuity-first"
          ? chatGptTurnSessions.find(executionKey) : undefined;
        const updatedTaskSession = !existingTaskSession && taskExecution && environment
          ? await tryTaskUpdateHandoff({ parsed, executionKey, ownerKey, namespace: executionNamespace,
            environment, execution: taskExecution, broker, result: brokerResult, onProgress: incoming.onProgress })
          : undefined;
        if (parsed._conversationPolicy === "continuity-first") {
          incoming.abortSignal?.throwIfAborted();
          if (!continuityReplay) chatGptTurnSessions.assertContinuityThreadAvailable(nativeIdentity.threadId!, executionKey);
        }
        const initialTaskSource = !existingTaskSession && !updatedTaskSession && taskExecution
          ? captureTaskUpdateSource(parsed, taskExecution) : undefined;
        if (initialTaskSource?.messages.length && broker.acceptTaskUpdate && broker.beginFinalOutput
          && broker.waitForTaskUpdateState && broker.revokeTrusted
          && (manualRequest || await worker.supportsTaskUpdates())) {
          if (Buffer.byteLength(canonicalJson(initialTaskSource.input)) + TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES
            > TASK_UPDATE_SESSION_JOURNAL_BYTES) {
            throw taskUpdateSourceError("task_update_capacity", "Task update source history capacity is exhausted.");
          }
          negotiatedTaskUpdates.add(parsed);
        }
        const session = parsed._conversationPolicy === "continuity-first"
          ? updatedTaskSession ?? continuityReplay ?? chatGptTurnSessions.getOrCreate(
            executionKey,
            () => startRuntime(parsed, environment, traceId, turnCapabilities),
            traceId, ownerKey, nativeTurnId, nativeIdentity.threadId, chatGptInstructionLineage(parsed).current,
          )
          : existingTaskSession ?? updatedTaskSession ?? await chatGptTurnSessions.getOrCreateAfterOwnerRetirement(
          executionKey,
          ownerKey,
          () => startRuntime(parsed, environment, traceId, turnCapabilities),
          traceId,
          incoming.abortSignal,
          nativeTurnId,
          nativeIdentity.threadId,
          chatGptInstructionLineage(parsed),
        );
        if (parsed._conversationPolicy === "continuity-first") {
          const prepared = preparedContinuity.get(parsed);
          session.acceptCanonicalInput(
            parsed,
            prepared?.instructionPrevious,
            prepared?.allowRetainedSourceInstructionPayload,
          );
        }
        if (taskExecution && session.runtime.taskUpdates && !session.taskUpdatesEnabled()) {
          session.initializeTaskUpdates(parsed, taskExecution);
        }
        const preservedCompactionFinal = taskExecution
          ? session.preservedCompactionFinalReplay(parsed, taskExecution, executionKey) : undefined;
        const taskRoute = taskExecution && session.taskUpdatesEnabled() && !preservedCompactionFinal
          ? session.acceptTaskUpdateRound(parsed, taskExecution) : undefined;
        const driverContext: TaskUpdateOwnerContext | undefined = taskRoute
          ? { expectedDriverGeneration: taskRoute.driverGeneration, taskRevision: taskRoute.acceptedRevision } : undefined;
        const roundKey = preservedCompactionFinal?.roundKey ?? taskRoute?.roundKey ?? (parsed._conversationPolicy === "continuity-first"
          ? session.continuityRoundKey(parsed)
          : chatGptTurnRoundKey(parsed));
        let emittedJournalEvents = 0;
        let completedRoundReplay = false;
        const completedRoundEvents: AdapterEvent[] = [];
        const assertOutputOwner = (): void => {
          if (!driverContext) return;
          if (completedRoundReplay) session.assertCompletedTaskUpdateRound(roundKey, driverContext);
          else session.assertDriverGeneration(driverContext.expectedDriverGeneration);
        };
        const ensureDriver = async (): Promise<void> => {
          if (!driverContext) return;
          await session.waitForTaskUpdatePreparation(incoming.abortSignal);
          assertOutputOwner();
        };
        const emitRoundEvents = (events: readonly AdapterEvent[], afterJournal?: () => void): void => {
          // Journal the complete synchronous event batch before touching the HTTP observer. If the
          // observer disconnects midway through emission, an exact reconnect can replay the entire
          // canonical batch instead of losing the already-drained tail.
          assertOutputOwner();
          if (completedRoundReplay) {
            completedRoundEvents.push(...events);
            return;
          }
          session.appendRoundEvents(roundKey, events);
          afterJournal?.();
          for (const event of events) { emit(event); emittedJournalEvents += 1; }
        };
        const emitRoundBatch = (
          produce: (buffer: (event: AdapterEvent) => void) => void,
          afterJournal?: () => void,
        ): void => {
          const events: AdapterEvent[] = [];
          produce(event => events.push(event));
          emitRoundEvents(events, afterJournal);
        };
        const authorizeFinalOutput = async (candidate: TaskUpdateOwnerContext | undefined): Promise<void> => {
          if (!session.runtime.taskUpdates) return;
          if (!candidate) throw taskUpdateSourceError("task_update_output_unproven", "Final text lacks its captured task version.");
          if (candidate.acknowledgedRevision !== undefined && candidate.acknowledgedRevision !== candidate.taskRevision) {
            throw taskUpdateSourceError("task_update_unacknowledged", "The final text was observed before its task revision was acknowledged.");
          }
          await ensureDriver();
          const control = session.runtime.taskUpdates;
          if (!control.outputReceipt) {
            if (session.runtime.mode !== "tools" || !broker.beginFinalOutput) throw taskUpdateSourceError(
              "task_update_upgrade_required", "The final output protocol is unavailable.");
            const started = await broker.beginFinalOutput(await session.runtime.token, candidate);
            // Completion may have committed while this earlier output-start reply was in flight.
            control.outputReceipt ??= started;
          }
          const receipt = control.outputReceipt;
          if (receipt.driverGeneration !== candidate.expectedDriverGeneration || receipt.taskRevision !== candidate.taskRevision) {
            throw taskUpdateSourceError("task_update_output_stale", "Final text does not belong to the committed task version.");
          }
          await ensureDriver();
        };
        const emitFinalText = async (records: { text: string; context?: TaskUpdateOwnerContext }[]): Promise<void> => {
          if (driverContext && records.some(record => record.text)) {
            assertOutputOwner();
            session.retainTaskUpdateOutputRound(roundKey, driverContext.expectedDriverGeneration);
          }
          // Draining owns consumption. Retain every strict candidate before any await so an
          // HTTP abort cannot discard its original admission evidence with the observer.
          if (bufferStructuredOutput && session.runtime.taskUpdates) {
            assertOutputOwner();
            for (const record of records) {
              if (!record.text) continue;
              if (!record.context) throw taskUpdateSourceError(
                "task_update_output_unproven", "The browser text candidate lost its task version.");
              session.appendRoundBufferedTextCandidate(roundKey, record.context);
            }
          }
          await ensureDriver();
          const events: AdapterEvent[] = [];
          for (const record of records) {
            if (!record.text) continue;
            if (session.runtime.taskUpdates && !record.context) throw taskUpdateSourceError(
              "task_update_output_unproven", "The browser text candidate lost its task version.");
            if (bufferStructuredOutput) {
              if (record.context) {
                await session.runtime.taskUpdates?.bufferedTextAdmission?.(record.context);
              }
            } else {
              await authorizeFinalOutput(record.context);
              events.push({ type: "text_delta", text: record.text, phase: "final_answer" });
            }
          }
          if (events.length) emitRoundEvents(events);
          if (records.length > 0) incoming.onProgress?.();
        };
        const emitStructuredAnswer = async (answer: string): Promise<void> => {
          if (session.runtime.taskUpdates) {
            const receipt = session.runtime.taskUpdates.outputReceipt ?? (session.runtime.mode === "tools"
              ? await broker.taskOutputReceipt!(await session.runtime.token) : undefined);
            if (!receipt) throw taskUpdateSourceError("task_update_output_unproven", "Structured completion lacks its committed version receipt.");
            session.runtime.taskUpdates.outputReceipt = receipt;
            const candidates = session.roundBufferedTextCandidates(roundKey);
            if (completedRoundReplay && answer && candidates.length === 0) throw taskUpdateSourceError(
              "task_update_output_unproven", "The buffered final text lost its original candidate evidence.");
            for (const candidate of candidates) {
              const admission = session.runtime.taskUpdates.bufferedTextAdmission?.(candidate);
              if (completedRoundReplay && !admission) throw taskUpdateSourceError(
                "task_update_output_unproven", "The buffered final text lost its original admission evidence.");
              await admission;
              await authorizeFinalOutput(candidate);
            }
            await authorizeFinalOutput({ expectedDriverGeneration: receipt.driverGeneration, taskRevision: receipt.taskRevision });
          }
          if (completedRoundReplay) {
            const recorded = session.roundEvents(roundKey).filter(event => event.type === "text_delta" && event.phase === "final_answer");
            if (recorded.length > 0) {
              if (recorded.map(event => event.type === "text_delta" ? event.text : "").join("") !== answer) {
                throw taskUpdateSourceError("task_update_output_unproven", "The recorded strict answer differs from the completed answer.");
              }
              return;
            }
          }
          emitRoundBatch(buffer => emitTextDeltas([answer], buffer));
        };
        const finalReplaySource = preparedContinuity.get(parsed)?.finalReplaySource;
        if (finalReplaySource) {
          await session.browserOutcome;
          await session.physicalSettlement;
          session.setFinalEvents(finalReplaySource.eventsForFinalReplay());
          session.setFinalReasoning(finalReplaySource.reasoningForFinalReplay());
        }
        let continuityAdmissionPending = parsed._conversationPolicy === "continuity-first";
        // Keep a settled capability through terminal registration in the outer error handler.
        const releaseRoundRegistration = driverContext && !session.roundCompleted(roundKey) && session.isActive()
          ? session.retainTaskUpdateTransaction() : undefined;
        try {
          await session.runExclusive(async () => {
            if (!driverContext && parsed._conversationPolicy === "continuity-first"
              && session.continuityRoundKey(parsed) !== roundKey) {
              throw continuityError("continuity_source_unproven", "The local work identity changed while this request was waiting for the execution lock.");
            }
            let turnToken: string | undefined;
            const updateTurnEnvironment = async (): Promise<string> => {
              if (session.runtime.mode !== "tools") throw new Error("Read-only ChatGPT Web runtime cannot update tool authority");
              const token = await withAbort(session.runtime.token, incoming.abortSignal);
              if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its current tool authority");
              const prepared = preparedContinuity.get(parsed);
              const binding = prepared?.binding;
              if (binding) {
                if (!session.isActive()) return token;
                if (prepared.bindings.lookup(binding.thread, binding.scope) !== binding
                  || chatGptTurnSessions.find(binding.executionKey!) !== session || binding.revision !== prepared.revision
                  || chatGptTurnSessions.findConversationHead(prepared.conversationKey) !== session
                  || session.supersededError) {
                  throw continuityError("continuity_source_unproven", "This execution no longer owns the current page environment.");
                }
                session.assertCanonicalReplayInput(parsed);
              }
              const registry = binding ? continuityToolRegistry(parsed, binding, session) : undefined;
              if (registry) {
                parsed.context.tools = registry.tools;
                environment = { ...environment, tools: registry.tools };
              }
              await ensureDriver();
              await broker.updateEnvironment(token, environment, driverContext);
              await ensureDriver();
              // Owner IPC can finish after this browser settles and another execution takes the
              // page. Its old response may replay, but cannot publish into the new owner's registry.
              if (binding && registry && binding.state !== "lost" && binding.state !== "ended"
                && prepared.bindings.observed(binding.thread) === binding
                && chatGptTurnSessions.find(binding.executionKey!) === session && binding.revision === prepared.revision
                && chatGptTurnSessions.findConversationHead(prepared.conversationKey) === session
                && !session.supersededError) {
                binding.discoveredTools = registry.discoveredTools;
              }
              return token;
            };
            // An active ordinary reconnect publishes its current registry before returning its
            // journal. Historical executions remain read-only and keep their original response.
            if (parsed._conversationPolicy === "continuity-first" && session.isActive()
              && session.runtime.mode === "tools") {
              turnToken = await updateTurnEnvironment();
            }
            continuityAdmissionPending = false;
            const replay = session.roundEvents(roundKey);
            replayEvents(replay, emit);
            emittedJournalEvents = replay.length;
            if (session.roundCompleted(roundKey)) {
              const failure = session.roundFailure(roundKey);
              if (failure) throw failure;
              return;
            }
            if (session.roundHasTerminalEvent(roundKey)) {
              session.completeRound(roundKey);
              return;
            }
            const settled = session.settledOutcome();
            if (driverContext && settled?.type === "final"
              && session.runtime.taskUpdates?.outputReceipt?.kind === "completed") {
              session.assertCompletedTaskUpdateRound(roundKey, driverContext);
              completedRoundReplay = true;
            }
            await ensureDriver();
            const releaseObserver = driverContext && !completedRoundReplay
              ? session.enterTaskUpdateObserver(roundKey, driverContext.expectedDriverGeneration, parsed) : undefined;
            try {
            if (settled) {
              if (settled.type === "error") throw settled.error;
              const trace = session.runtime.trace.drain();
              const completedTextDeltas = session.runtime.text.drainWithContext();
              const finalReplay = replay.length === 0
                && trace.length === 0
                && completedTextDeltas.length === 0
                ? session.eventsForFinalReplay()
                : [];
              if (finalReplay.length > 0) {
                session.appendRoundReasoning(roundKey, session.reasoningForFinalReplay());
                emitRoundEvents(finalReplay);
              } else {
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                if (replay.length === 0 && !parsed._compactionRequest) {
                  emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
                }
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
                await emitFinalText(completedTextDeltas);
              }
              if (trace.length > 0 && completedTextDeltas.length === 0) incoming.onProgress?.();
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              structuredOutputValidator?.(settled.answer);
              if (bufferStructuredOutput) {
                await emitStructuredAnswer(settled.answer);
              }
              const reasoning = session.roundReasoning(roundKey);
              session.setFinalReasoning(reasoning);
              if (!completedRoundReplay) session.setFinalEvents(session.roundEvents(roundKey));
              emitRoundBatch(buffer => emitBrowserCompletion(
                settled,
                estimateChatGptWebUsage(currentUsageInput(parsed), { answer: settled.answer, reasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                buffer,
              ));
              if (completedRoundReplay) {
                // Recover the answer and terminal as one journal transaction. Another HTTP
                // disconnect during emission then replays a complete round without regeneration.
                assertOutputOwner();
                session.appendRoundEvents(roundKey, completedRoundEvents);
                session.setFinalEvents(session.roundEvents(roundKey));
                session.completeRound(roundKey);
                for (const event of completedRoundEvents) { emit(event); emittedJournalEvents += 1; }
              } else session.completeRound(roundKey);
              chatGptWebTurnRetryPolicy.clear(retryKey);
              return;
            }

            if (session.runtime.mode === "tools") {
              if (!turnToken) {
                turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
                if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its current tool authority");
                await ensureDriver();
                await broker.updateEnvironment(turnToken, environment, driverContext);
                await ensureDriver();
              }
              const updatedOutcome = session.settledOutcome();
              if (updatedOutcome?.type === "error") throw updatedOutcome.error;

              const outstanding = session.isActive() ? session.outstanding() : [];
              if (outstanding.length > 0) {
                const results = parsed._conversationPolicy === "continuity-first"
                  ? session.acceptContinuityToolResults(parsed)
                  : session.taskUpdatesEnabled() ? session.acceptTaskUpdateToolResults(parsed)
                  : currentToolResults(parsed, session);
                if (results.length === 0) {
                  const reasoning = session.reasoningForOutstandingReplay();
                  if (replay.length === 0) emitRoundEvents(session.eventsForOutstandingReplay());
                  emitRoundBatch(buffer => emitToolBatch(
                    outstanding,
                    estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: outstanding }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                    buffer,
                  ));
                  session.completeRound(roundKey);
                  return;
                }
                if (results.length !== outstanding.length && !session.runtime.continuityBinding) {
                  throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
                }
                for (const message of results) {
                  await ensureDriver();
                  await broker.completeTool(turnToken, message.toolCallId, brokerResult(message,
                    session.continuityReceivedToolResult(message.toolCallId)
                      ?? (driverContext ? rawToolResult(parsed, message.toolCallId) : undefined)), driverContext);
                  await ensureDriver();
                  session.runtime.externalProgress.recordToolResult();
                  incoming.onProgress?.();
                  session.markResultDelivered(message.toolCallId);
                }
                if (session.outstanding().length > 0) {
                  emitRoundBatch(buffer => emitToolBatch(session.outstanding(),
                    estimateChatGptWebUsage(currentUsageInput(parsed), { toolRequests: session.outstanding() }, turnCapabilities,
                      experimentalBiggerContext, experimentalSkillAttachments), buffer));
                  session.completeRound(roundKey);
                  return;
                }
              }
            } else if (session.outstanding().length > 0) {
              throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
            }

            const toolWaitAbort = new AbortController();
            try {
              const roundReasoning = session.roundReasoning(roundKey);
              const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
                if (trace.length > 0) incoming.onProgress?.();
                roundReasoning.push(...trace.map(event => event.text));
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
              };
              const emitNewText = emitFinalText;
              if (replay.length === 0 && !parsed._compactionRequest) {
                emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
              }
              emitNewTrace(session.runtime.trace.drain());
              await emitNewText(session.runtime.text.drainWithContext());
              const externalProgress = session.runtime.mode === "tools"
                ? session.runtime.externalProgress
                : undefined;
              const armNextTools = () => turnToken && session.isActive()
                ? broker.nextToolBatch(turnToken, toolWaitAbort.signal, driverContext).then(async requests => {
                  await ensureDriver();
                  if (!externalProgress) {
                    throw new Error("ChatGPT broker returned tools for a read-only browser turn");
                  }
                  if (requests.length > 0) {
                    const revision = externalProgress.recordToolBatch(requests.length);
                    incoming.onProgress?.();
                    if (!session.runtime.manualControl) {
                      // The browser outcome is in the same race below and owns the semantic DOM and
                      // renderer deadlines. A second fixed timer here can retire an accepted turn
                      // while its same-tab observer is still recovering. Keep the causal barrier —
                      // tools are not emitted until the browser captures their text boundary — but
                      // let browser settlement or request cancellation end the wait.
                      await externalProgress.waitForToolBatchObservation(
                        revision,
                        toolWaitAbort.signal,
                      );
                    }
                    externalProgress.assertToolBatchActive(revision);
                  }
                  await ensureDriver();
                  return { type: "tools" as const, requests };
                }).catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error))
                : undefined;
              let nextTools = armNextTools();
              const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
              const finishBrowserOutcome = async (completedOutcome: ChatGptBrowserOutcome): Promise<void> => {
                await ensureDriver();
                // Zero Risk completion and its owner-only empty-batch signal are resolved by the
                // same broker transition. Drain once more so the accepted final answer cannot be
                // overtaken by the terminal owner notification.
                emitNewTrace(session.runtime.trace.drain());
                await ensureDriver();
                await emitNewText(session.runtime.text.drainWithContext());
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(session.roundEvents(roundKey));
                if (completedOutcome.type === "error") throw completedOutcome.error;
                if (session.runtime.text.value() !== completedOutcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                structuredOutputValidator?.(completedOutcome.answer);
                if (bufferStructuredOutput) {
                  await emitStructuredAnswer(completedOutcome.answer);
                }
                emitRoundBatch(buffer => emitBrowserCompletion(
                  completedOutcome,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { answer: completedOutcome.answer, reasoning: roundReasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                  buffer,
                ));
                session.completeRound(roundKey);
                chatGptWebTurnRetryPolicy.clear(retryKey);
              };
              const waitForTrace = () => session.runtime.trace.wait(toolWaitAbort.signal)
                .then(() => ({ type: "trace" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              const waitForText = () => session.runtime.text.wait(toolWaitAbort.signal)
                .then(() => ({ type: "text" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              let nextTrace = waitForTrace();
              let nextText = waitForText();
              let driverChange = driverContext ? session.waitForDriverChange(driverContext.expectedDriverGeneration, toolWaitAbort.signal)
                .then(() => ({ type: "driver_change" as const })) : undefined;
              for (;;) {
                const next = await withAbort(
                  Promise.race([
                    ...(nextTools ? [nextTools] : []),
                    browserOutcome,
                    nextTrace,
                    nextText,
                    ...(driverChange ? [driverChange] : []),
                  ]),
                  incoming.abortSignal,
                );
                if (next.type === "driver_change") {
                  await ensureDriver();
                  driverChange = session.waitForDriverChange(driverContext!.expectedDriverGeneration, toolWaitAbort.signal)
                    .then(() => ({ type: "driver_change" as const }));
                  continue;
                }
                await ensureDriver();
                if (next.type === "trace") {
                  emitNewTrace(session.runtime.trace.drain());
                  nextTrace = waitForTrace();
                  continue;
                }
                if (next.type === "text") {
                  await emitNewText(session.runtime.text.drainWithContext());
                  nextText = waitForText();
                  continue;
                }
                emitNewTrace(session.runtime.trace.drain());
                await emitNewText(session.runtime.text.drainWithContext());
                if (next.type === "browser") {
                  await finishBrowserOutcome(next.outcome);
                  return;
                }
                if (!turnToken || session.runtime.mode !== "tools" || !externalProgress) {
                  throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
                }
                if (next.requests.length === 0) {
                  if (!session.runtime.manualControl) {
                    throw new Error("ChatGPT tool bridge returned an empty batch");
                  }
                  await finishBrowserOutcome(await session.browserOutcome);
                  return;
                }
                validateBatchTools(parsed, next.requests);
                session.setOutstanding(next.requests, roundReasoning, session.roundEvents(roundKey));
                emitRoundBatch(buffer => emitToolBatch(
                  next.requests,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                  buffer,
                ), () => {
                  // A disconnected HTTP observer must leave the whole source proof available
                  // to exact replay and the following result-plus-update request.
                  session.completeRound(roundKey);
                  if (session.taskUpdatesEnabled()) {
                    session.recordTaskUpdateToolBatch(roundKey, next.requests, externalProgress.snapshot().lastToolBatchRevision);
                  }
                });
                return;
              }
            } finally {
              toolWaitAbort.abort();
            }
            } finally { releaseObserver?.(); }
          });
        } catch (error) {
          if (driverContext && session.hasPendingTaskUpdate()) {
            // A disconnected observer leaves an unresolved transfer owned by its retained
            // transaction; it cannot revoke a possible new driver while awaiting a receipt.
            await session.waitForTaskUpdatePreparation(incoming.abortSignal);
          }
          if (driverContext && session.driverGeneration() !== driverContext.expectedDriverGeneration
            && (!session.isTaskUpdateCancelled() || session.roundHasTerminalEvent(roundKey))) {
            // A successful handoff owns the old observer's terminal journal. Late abort/cleanup
            // can only finish this HTTP observer, never cancel the newly accepted physical owner.
            replayEvents(session.roundEvents(roundKey).slice(emittedJournalEvents), emit);
            return;
          }
          if (continuityAdmissionPending && error instanceof ChatGptWebAdapterError
            && error.code === "continuity_source_unproven") throw error;
          if (incoming.abortSignal?.aborted && error instanceof DOMException && error.name === "AbortError") {
            if (session.runtime.manualControl && parsed._conversationPolicy !== "continuity-first") {
              // Zero Risk is user-driven and has no DOM observer that can distinguish continued
              // work from a stopped native turn. A closed Responses stream is therefore terminal:
              // revoke the MCP capability and release the Launcher tab instead of leaving a task
              // that Codex already shows as stopped waiting forever.
              chatGptTurnSessions.retire(executionKey, session);
            }
            // Automatic browser turns keep their exact execution and journal for reconnect. Their
            // owned DOM observer can continue proving the same accepted ChatGPT submission.
            throw error;
          }
          const turnError = submittedTurnFailure(session, error);
          const handledError = turnError instanceof ChatGptWebAdapterError && turnError.retryable
            ? chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, turnError)
            : turnError;
          if (!(turnError instanceof ChatGptWebAdapterError && turnError.retryable)) {
            chatGptWebTurnRetryPolicy.clear(retryKey);
          }
          const retryableContinuityCreation = handledError instanceof ChatGptWebAdapterError
            && handledError.code === "continuity_resource_capacity"
            && session.runtime.continuityBinding !== undefined
            && chatGptTurnSessions.discardRetryableContinuityCreation(
              executionKey,
              session,
              session.runtime.continuityBinding,
            );
          let terminalError: AdapterEvent | undefined = handledError instanceof ChatGptWebAdapterError ? {
            type: "error",
            message: handledError.message,
            status: handledError.status,
            errorType: handledError.errorType,
            code: handledError.code,
            retryable: handledError.retryable,
          } : undefined;
          // The same-generation observer owns its error journal even when its runtime has
          // already stopped. Register the terminal result before cleanup closes authority.
          try {
            if (terminalError?.type === "error") {
              terminalError = session.appendRoundError(roundKey, terminalError);
              session.completeRound(roundKey);
            } else {
              session.failRound(roundKey, turnError);
            }
          } finally {
            // A refused round owns its error journal, but cannot clean up another round at the
            // same generation. Cleanup also remains closed to an observer from an older driver.
            const ownsDriver = !driverContext
              || session.ownsTaskUpdateOutputRound(roundKey, driverContext.expectedDriverGeneration);
            try {
              if (ownsDriver && !retryableContinuityCreation) {
                if ((handledError instanceof ChatGptWebAdapterError && !handledError.retryable)
                  || (terminalError?.type === "error" && terminalError.retryable === false)) {
                  // Keep deterministic request failures replayable on their original round.
                  session.cancel();
                } else {
                  chatGptTurnSessions.retire(executionKey, session);
                }
              }
            } finally {
              if (ownsDriver && session.runtime.mode === "tools") {
                void session.runtime.token.then(turnToken => broker.revoke(turnToken, turnError, driverContext)).catch(() => {});
              }
            }
          }
          if (terminalError) {
            emit(terminalError);
            return;
          }
          chatGptWebTurnRetryPolicy.clear(retryKey);
          throw turnError;
        } finally {
          releaseRoundRegistration?.();
        }
      };

      // Emit initial liveness immediately. HTTP callers run trusted-environment preflight first,
      // while direct adapter callers keep the original runTurn event contract.
      emit({ type: "heartbeat" });
      const heartbeat = setInterval(
        () => emit({ type: "heartbeat" }),
        CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
      );
      try {
        await runChatGptWebTurn();
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
