import { parseDataUrl } from "../image";
import type {
  CodexContentPart,
  CodexParsedRequest,
  CodexToolResultMessage,
} from "../../types";
import { COMPACT_PROMPT } from "../../responses/compaction";
import { extractChatGptCompactionSourceRevision } from "./environment";
import type { ChatGptBrowserWorker } from "./browser-worker";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "./adapter-error";
import type { CompactionTransactionHandle } from "./compaction-transaction";
import type { ChatGptWebCapabilities } from "./model";
import {
  activeCompactionToolResultInstruction,
  structuredCompactionHandoffInstruction,
  zeroRiskActiveCompactionToolResultInstruction,
} from "./native-compaction-control";
import type { BrokerToolResult, TurnBroker, TurnBrokerOwner } from "./turn-broker";
import type { ChatGptBrowserOutcome, ChatGptTurnSession } from "./turn-execution";
import type { ContinuityClaim, ContinuityLease } from "./continuity-contract";
import { assertContinuityCompiledInput } from "./continuity-input";
import { continuityError } from "./continuity-errors";
import { taskUpdateSourceError } from "./task-update-source";

export const LATEST_USER_PROMPT_MARKER = "CODEX_LATEST_USER_PROMPT_JSON";

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function interruptedByActiveCompaction(): BrokerToolResult {
  return {
    content: [{ type: "text", text: activeCompactionToolResultInstruction() }],
    isError: true,
  };
}

function withZeroRiskCompactionInstruction(
  result: BrokerToolResult,
  compactPrompt: string,
): BrokerToolResult {
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: zeroRiskActiveCompactionToolResultInstruction(true, compactPrompt),
      },
    ],
  };
}

function interruptedByZeroRiskCompaction(compactPrompt: string): BrokerToolResult {
  return {
    content: [{
      type: "text",
      text: zeroRiskActiveCompactionToolResultInstruction(false, compactPrompt),
    }],
    isError: true,
  };
}

function compactionPrompt(parsed: CodexParsedRequest): string {
  if (parsed._compactionOutput !== "message") return COMPACT_PROMPT;
  const control = parsed.context.messages.at(-1);
  if (control?.role !== "user") {
    throw new Error("Local compaction is missing its native compact_prompt control message");
  }
  const text = typeof control.content === "string"
    ? control.content
    : control.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  if (!text.trim()) throw new Error("Local compaction compact_prompt must not be empty");
  return text;
}

function userPromptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as { type?: unknown; text?: unknown };
    return (value.type === "input_text" || value.type === "text") && typeof value.text === "string"
      ? [value.text]
      : [];
  }).join("\n");
  return text || undefined;
}

export function canonicalizeCompactionHandoff(
  parsed: CodexParsedRequest,
  summary: string,
): string {
  const normalized = summary.trim();
  if (!normalized) throw new Error("ChatGPT returned an empty structured compaction handoff");
  const latestUserPrompt = userPromptText(extractChatGptCompactionSourceRevision(parsed).content);
  if (latestUserPrompt === undefined) {
    throw new Error("ChatGPT compaction source has no canonical latest user prompt");
  }
  const appendix = `${LATEST_USER_PROMPT_MARKER}\n${JSON.stringify(latestUserPrompt)}`;
  const markerOffset = normalized.lastIndexOf(`\n${LATEST_USER_PROMPT_MARKER}\n`);
  if (markerOffset < 0) return `${normalized}\n\n${appendix}`;
  if (normalized.slice(markerOffset + 1).trimEnd() !== appendix) {
    throw new Error("ChatGPT compaction handoff contains a conflicting latest-user marker");
  }
  return normalized;
}

function currentToolResults(
  parsed: CodexParsedRequest,
  session: ChatGptTurnSession,
): Map<string, CodexToolResultMessage> {
  const results = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (results.has(message.toolCallId)) {
      throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    }
    results.set(message.toolCallId, message);
  }
  return results;
}

export const MAX_COMPACTION_HANDOFF_TIMEOUT_MS = 5 * 60_000;

function boundedCompactionTimeout(timeoutMs: number): number {
  return Math.min(timeoutMs, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("ChatGPT compaction handoff aborted", "AbortError");
}

export function withCompactionAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function waitForActiveCompactionBrowserOutcome(
  source: ChatGptTurnSession,
  signal?: AbortSignal,
  onProgress?: () => void,
): Promise<ChatGptBrowserOutcome> {
  const reportProgress = (): void => onProgress?.();
  const stopTraceObservation = source.runtime.trace.observe(reportProgress);
  const stopTextObservation = source.runtime.text.observe(reportProgress);
  try {
    return await withCompactionAbort(source.browserOutcome, signal);
  } finally {
    stopTraceObservation();
    stopTextObservation();
  }
}

export async function settleActiveCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  signal?: AbortSignal,
  onProgress?: () => void,
  alreadyExclusive = false,
): Promise<{ answer: string; compactionInstructionDelivered: boolean }> {
  const settle = async (): Promise<{ answer: string; compactionInstructionDelivered: boolean }> => {
    if (signal?.aborted) {
      source.cancel(abortReason(signal));
      throw abortReason(signal);
    }
    if (!source.isActive() || source.runtime.mode !== "tools") {
      if (parsed._conversationPolicy === "continuity-first" && !source.isActive()) {
        const outcome = await source.browserOutcome;
        if (outcome.type === "error") throw outcome.error;
        await withCompactionAbort(source.physicalSettlement, signal);
        return { answer: outcome.answer, compactionInstructionDelivered: false };
      }
      throw new Error("The active ChatGPT compaction source has no MCP tool boundary");
    }
    const outstanding = source.outstanding();
    if (source.hasPendingTaskUpdate()) throw taskUpdateSourceError("task_update_pending", "Resolve the task update transfer before starting compaction.");
    const driverContext = source.taskUpdatesEnabled() ? source.taskUpdateOwnerContext() : undefined;
    const results = parsed._conversationPolicy === "continuity-first"
      ? new Map(source.acceptContinuityToolResults(parsed).map(message => [message.toolCallId, message]))
      : source.taskUpdatesEnabled()
        ? new Map(source.acceptTaskUpdateToolResults(parsed).map(message => [message.toolCallId, message]))
        : currentToolResults(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(
        `Codex supplied ${results.size} of ${outstanding.length} required tool results for compaction`,
      );
    }
    let token: string | undefined;
    let compactionAccepted = false;
    try {
      token = await source.runtime.token;
      await broker.requestCompaction(token, interruptedByActiveCompaction(), driverContext);
      compactionAccepted = true;
      for (const request of outstanding) {
        const result = results.get(request.callId)!;
        await broker.completeTool(
          token,
          request.callId,
          toolResult(result),
          driverContext,
        );
        if (driverContext) source.assertDriverGeneration(driverContext.expectedDriverGeneration);
        source.runtime.externalProgress.recordToolResult();
        onProgress?.();
        source.markResultDelivered(request.callId);
      }
      const browserOutcome = await waitForActiveCompactionBrowserOutcome(source, signal, onProgress);
      if (browserOutcome.type === "error") throw browserOutcome.error;
      const compactionInstructionDelivered = broker.compactionDeliveryCount(token) > 0;
      // The one structured checkpoint message reuses this exact retained tab. It must not race the
      // helper's /turn/end handshake for the response that consumed the canonical tool results.
      // `requestCompaction` leaves those results untouched and only intercepts a later tool call, so
      // a zero delivery count proves that this is an ordinary publishable terminal response.
      await withCompactionAbort(source.physicalSettlement, signal);
      return {
        answer: browserOutcome.answer,
        compactionInstructionDelivered,
      };
    } catch (error) {
      if (signal?.aborted) source.cancel(abortReason(signal));
      throw error;
    } finally {
      if (token && compactionAccepted) await broker.revoke(token, undefined, driverContext);
    }
  };
  return alreadyExclusive ? settle() : source.runExclusive(settle);
}

export async function settleActiveZeroRiskCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBrokerOwner,
  signal?: AbortSignal,
  onProgress?: () => void,
  onAcceptedHandoff?: (summary: string) => void,
  alreadyExclusive = false,
): Promise<string | undefined> {
  const compactPrompt = compactionPrompt(parsed);
  const settle = async (): Promise<string | undefined> => {
    if (signal?.aborted) {
      source.cancel(abortReason(signal));
      throw abortReason(signal);
    }
    if (!source.isActive() || source.runtime.mode !== "tools" || !source.runtime.manualControl) {
      if (parsed._conversationPolicy === "continuity-first" && !source.isActive()) {
        const outcome = await source.browserOutcome;
        if (outcome.type === "error") throw outcome.error;
        await withCompactionAbort(source.physicalSettlement, signal);
        return undefined;
      }
      throw new Error("The active Zero Risk compaction source has no manual MCP tool boundary");
    }
    const outstanding = source.outstanding();
    if (source.hasPendingTaskUpdate()) throw taskUpdateSourceError("task_update_pending", "Resolve the task update transfer before starting compaction.");
    const driverContext = source.taskUpdatesEnabled() ? source.taskUpdateOwnerContext() : undefined;
    const results = parsed._conversationPolicy === "continuity-first"
      ? new Map(source.acceptContinuityToolResults(parsed).map(message => [message.toolCallId, message]))
      : source.taskUpdatesEnabled()
        ? new Map(source.acceptTaskUpdateToolResults(parsed).map(message => [message.toolCallId, message]))
        : currentToolResults(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(
        `Codex supplied ${results.size} of ${outstanding.length} required tool results for Zero Risk compaction`,
      );
    }
    let token: string | undefined;
    let compactionAccepted = false;
    try {
      token = await source.runtime.token;
      const interruptedQueued = await broker.requestCompaction(
        token,
        interruptedByZeroRiskCompaction(compactPrompt),
        driverContext,
      );
      compactionAccepted = true;
      for (const [index, request] of outstanding.entries()) {
        const result = results.get(request.callId)!;
        const canonical = toolResult(result);
        await broker.completeTool(
          token,
          request.callId,
          interruptedQueued === 0 && index === outstanding.length - 1
            ? withZeroRiskCompactionInstruction(canonical, compactPrompt)
            : canonical,
          driverContext,
        );
        if (driverContext) source.assertDriverGeneration(driverContext.expectedDriverGeneration);
        source.runtime.externalProgress.recordToolResult();
        onProgress?.();
        source.markResultDelivered(request.callId);
      }
      const browserOutcome = await waitForActiveCompactionBrowserOutcome(source, signal, onProgress);
      if (browserOutcome.type === "error") throw browserOutcome.error;
      const instructionDelivered = outstanding.length > 0
        || await broker.compactionDeliveryCount(token) > 0;
      const summary = browserOutcome.answer.trim();
      if (instructionDelivered) {
        if (!summary) throw new Error("The active Zero Risk response returned an empty compaction summary");
        onAcceptedHandoff?.(summary);
      }
      await withCompactionAbort(source.physicalSettlement, signal);
      if (!instructionDelivered) return undefined;
      return summary;
    } catch (error) {
      if (signal?.aborted) source.cancel(abortReason(signal));
      throw error;
    } finally {
      if (token && compactionAccepted) await broker.revoke(token, undefined, driverContext);
    }
  };
  return alreadyExclusive ? settle() : source.runExclusive(settle);
}

export async function requestRetainedCompactionHandoff(
  worker: ChatGptBrowserWorker,
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  capabilities: ChatGptWebCapabilities,
  traceId: string,
  signal?: AbortSignal,
  timeoutMs = MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  onProgress?: () => void,
  continuity?: {
    claim: ContinuityClaim;
    onLease: (lease: ContinuityLease) => void;
    onPhysicalSettlement: (settlement: Promise<void>) => void;
    onAcceptedHandoff: (summary: string) => void;
    onPrepared?: (instruction: string) => Promise<ContinuityClaim>;
    onSendActivated?: () => Promise<void>;
    onSubmitted?: () => void;
  },
): Promise<string> {
  const conversationKey = source.conversationKey();
  if (!conversationKey) throw new Error("The completed ChatGPT source has no retained conversation identity");
  const operationTimeoutMs = boundedCompactionTimeout(timeoutMs);
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(new Error(`ChatGPT compaction handoff timed out after ${operationTimeoutMs}ms`)),
    operationTimeoutMs,
  );
  deadlineTimer.unref?.();
  const operationSignal = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  const browserAbort = new AbortController();
  const abortBrowser = () => browserAbort.abort(operationSignal.reason);
  let transaction: CompactionTransactionHandle | undefined;
  let browser: Promise<string> | undefined;
  if (operationSignal.aborted) abortBrowser();
  else operationSignal.addEventListener("abort", abortBrowser, { once: true });
  try {
    const transactionPromise = broker.beginCompactionTransaction(traceId, operationTimeoutMs);
    void transactionPromise.then(lateTransaction => {
      if (operationSignal.aborted && transaction !== lateTransaction) {
        broker.abortCompactionTransaction(lateTransaction.token);
      }
    }, () => {});
    transaction = await withCompactionAbort(transactionPromise, operationSignal);
    const instruction = structuredCompactionHandoffInstruction(transaction, compactionPrompt(parsed));
    if (continuity) assertContinuityCompiledInput({ text: instruction, images: [] }, {
      ...parsed, context: { ...parsed.context, messages: [] },
    }, capabilities);
    const prepare = async () => ({ text: instruction, images: [], release: () => {} });
    const continuityClaim = continuity?.onPrepared ? await continuity.onPrepared(instruction) : continuity?.claim;
    operationSignal.throwIfAborted();
    browser = worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
      ...(continuity ? {
        continuity: continuityClaim!,
        onContinuityLease: continuity.onLease,
        onSendActivated: continuity.onSendActivated,
        onSubmitted: continuity.onSubmitted,
        retainConversation: true,
      } : {}),
      // The retained connector exposes only the one-shot control token embedded above. It does
      // not receive an ordinary Codex tool environment for this checkpoint message.
      capabilities: { ...capabilities, localToolsEnabled: false },
      nativeConnector: true,
      prepare,
      prepareResume: prepare,
      conversationKey,
      requireRetainedConversation: true,
      compaction: true,
      abortSignal: browserAbort.signal,
      onTextDelta: () => { onProgress?.(); },
    });
    continuity?.onPhysicalSettlement(browser.then(() => undefined, () => undefined));
    const handoff = broker.waitForCompactionHandoff(transaction.token, operationSignal);
    const browserWithoutHandoff = browser.then<never>(() => {
      // The control handler accepts the summary before replying to ChatGPT. A fully
      // settled response without that receipt cannot become a successful checkpoint.
      throw new ChatGptWebAdapterError(
        "ChatGPT finished without sending the context summary to Codex. Check its response for a refusal or tool error.",
        { status: 409, errorType: "invalid_request_error", code: "compaction_handoff_missing", retryable: false },
      );
    });
    const summary = await withCompactionAbort(
      Promise.race([
        handoff,
        browserWithoutHandoff,
      ]),
      operationSignal,
    );
    continuity?.onAcceptedHandoff(summary);
    onProgress?.();
    // The one-shot control submission is the terminal event for this purpose-built response.
    // ChatGPT may render no assistant text after a tool-only response, and therefore no Copy
    // action. End our owned turn explicitly and wait for the launcher/helper cleanup handshake.
    browserAbort.abort(new ChatGptCompactionHandoffAccepted());
    await withCompactionAbort(
      browser.then(() => undefined, () => undefined),
      operationSignal,
    );
    return summary;
  } finally {
    browserAbort.abort();
    if (transaction) broker.abortCompactionTransaction(transaction.token);
    if (browser) {
      // Logical cancellation is not physical retirement. The retained-session owner tracks
      // physical settlement separately, so this helper must not turn its own deadline into an
      // unbounded wait when the worker does not acknowledge abort immediately.
      await withCompactionAbort(
        browser.then(() => undefined, () => undefined),
        operationSignal,
      ).catch(() => {});
    }
    operationSignal.removeEventListener("abort", abortBrowser);
    clearTimeout(deadlineTimer);
  }
}

interface CachedCompactionRun {
  createdAt: number;
  ownerKey: string;
  traceIds: Set<string>;
  nativeTurnIdentities: Set<string>;
  requestDigest?: string;
  abort: AbortController;
  active: boolean;
  promise: Promise<unknown>;
  settlement: Promise<void>;
  retainFailedResult?: true;
}

interface StructuredCompactionInterruption {
  createdAt: number;
  reason: Error;
}

export interface StructuredCompactionOwner {
  ownerKey: string;
  /** Every externally addressable browser trace owned by this structured compaction. */
  traceIds: readonly string[];
  /** Exact native Codex owner, when supplied by the current Responses request. */
  nativeThreadId?: string;
  nativeTurnId?: string;
  /** Optional exact semantic payload guard for callers whose work key intentionally omits content. */
  requestDigest?: string;
  /** A strict failure is replay evidence, never permission to generate another summary. */
  retainFailedResult?: true;
}

const structuredCompactionRuns = new Map<string, CachedCompactionRun>();
const structuredCompactionOwners = new Map<string, Promise<void>>();
const structuredCompactionInterruptions = new Map<string, StructuredCompactionInterruption>();
const STRUCTURED_COMPACTION_RUN_TTL_MS = 30 * 60_000;
const MAX_STRUCTURED_COMPACTION_IDENTITIES = 256;

function nativeTurnIdentityKey(threadId: string, turnId: string): string {
  if (!threadId.trim() || !turnId.trim()) {
    throw new Error("Structured compaction requires non-empty native thread and turn ids");
  }
  return JSON.stringify([threadId, turnId]);
}

function rememberStructuredCompactionInterruption(threadId: string, turnId: string, reason: Error): void {
  const identity = nativeTurnIdentityKey(threadId, turnId);
  const now = Date.now();
  pruneStructuredCompactionInterruptions(now);
  const existing = structuredCompactionInterruptions.get(identity);
  if (existing) {
    existing.createdAt = now;
    return;
  }
  structuredCompactionInterruptions.set(identity, { createdAt: now, reason });
}

function structuredCompactionInterruption(owner: StructuredCompactionOwner): Error | undefined {
  if (owner.nativeThreadId === undefined && owner.nativeTurnId === undefined) return undefined;
  pruneStructuredCompactionInterruptions();
  return structuredCompactionInterruptions.get(
    nativeTurnIdentityKey(owner.nativeThreadId ?? "", owner.nativeTurnId ?? ""),
  )?.reason;
}

function registerStructuredCompactionOwner(
  run: Pick<CachedCompactionRun, "ownerKey" | "traceIds" | "nativeTurnIdentities" | "active">,
  owner: StructuredCompactionOwner,
): void {
  if (run.ownerKey !== owner.ownerKey) throw continuityError("continuity_source_unproven");
  if (!run.active) return;
  const nativeIdentity = owner.nativeThreadId === undefined && owner.nativeTurnId === undefined
    ? undefined : nativeTurnIdentityKey(owner.nativeThreadId ?? "", owner.nativeTurnId ?? "");
  if (run.active && nativeIdentity && !run.nativeTurnIdentities.has(nativeIdentity)) {
    const interrupted = structuredCompactionInterruption(owner);
    if (interrupted) throw interrupted;
  }
  const traces = new Set(owner.traceIds.filter(traceId => !run.traceIds.has(traceId)));
  const identityCount = run.traceIds.size + run.nativeTurnIdentities.size + traces.size
    + (nativeIdentity && !run.nativeTurnIdentities.has(nativeIdentity) ? 1 : 0);
  if (identityCount > MAX_STRUCTURED_COMPACTION_IDENTITIES) {
    throw continuityError("continuity_resource_capacity", "The shared compaction cancellation identity registry is full.");
  }
  for (const traceId of traces) run.traceIds.add(traceId);
  if (nativeIdentity) run.nativeTurnIdentities.add(nativeIdentity);
}

function pruneStructuredCompactionInterruptions(now = Date.now()): void {
  const cutoff = now - STRUCTURED_COMPACTION_RUN_TTL_MS;
  for (const [identity, interruption] of structuredCompactionInterruptions) {
    if (interruption.createdAt < cutoff) structuredCompactionInterruptions.delete(identity);
  }
}

function pruneStructuredCompactionRuns(): void {
  const now = Date.now();
  const cutoff = now - STRUCTURED_COMPACTION_RUN_TTL_MS;
  for (const [candidate, run] of structuredCompactionRuns) {
    if (!run.active && run.createdAt < cutoff) structuredCompactionRuns.delete(candidate);
  }
  pruneStructuredCompactionInterruptions(now);
}

/** Return the canonical result of an exact compact request, even after its source was retired. */
export function existingStructuredCompactionRun<T = string>(
  key: string,
  requestDigest?: string,
  owner?: StructuredCompactionOwner,
): Promise<T> | undefined {
  pruneStructuredCompactionRuns();
  const run = structuredCompactionRuns.get(key);
  if (run && requestDigest !== undefined && run.requestDigest !== requestDigest) {
    throw continuityError("continuity_source_unproven", "The compaction request payload conflicts with the retained transaction.");
  }
  if (run && owner) registerStructuredCompactionOwner(run, owner);
  return run?.promise as Promise<T> | undefined;
}

/** Preserve a failed run only after the caller crossed its irreversible control boundary. */
export function retainStructuredCompactionFailure(key: string): void {
  const run = structuredCompactionRuns.get(key);
  if (run) run.retainFailedResult = true;
}

export function runStructuredCompactionOnce<T = string>(
  key: string,
  owner: StructuredCompactionOwner,
  start: (operatorSignal: AbortSignal, retainOwnershipUntil: (settlement: Promise<void>) => void) => Promise<T>,
): Promise<T> {
  pruneStructuredCompactionRuns();
  const existing = structuredCompactionRuns.get(key);
  if (existing) {
    if (owner.requestDigest !== undefined && existing.requestDigest !== owner.requestDigest) {
      return Promise.reject(continuityError(
        "continuity_source_unproven",
        "The compaction request payload conflicts with the retained transaction.",
      ));
    }
    try { registerStructuredCompactionOwner(existing, owner); }
    catch (error) { return Promise.reject(error); }
    return existing.promise as Promise<T>;
  }
  const interrupted = structuredCompactionInterruption(owner);
  if (interrupted) return Promise.reject(interrupted);
  const registrations = {
    ownerKey: owner.ownerKey, traceIds: new Set<string>(), nativeTurnIdentities: new Set<string>(), active: true,
  };
  registerStructuredCompactionOwner(registrations, owner);
  const abort = new AbortController();
  const previousOwner = structuredCompactionOwners.get(owner.ownerKey);
  const physicalSettlements: Promise<void>[] = previousOwner ? [previousOwner] : [];
  const promise = Promise.resolve().then(async () => {
    if (previousOwner) await withCompactionAbort(previousOwner, abort.signal);
    if (abort.signal.aborted) throw abortReason(abort.signal);
    return start(abort.signal, settlement => { physicalSettlements.push(settlement); });
  });
  // Return a deadline failure promptly, while its physical browser owner still blocks retries
  // and cancel-all completion. A cancelled queued run must also retain its predecessor's gate.
  const ownerSettlement = promise.then(() => false, () => true).then(async failed => {
    await Promise.allSettled(physicalSettlements);
    run.active = false;
    if (structuredCompactionOwners.get(owner.ownerKey) === ownerSettlement) {
      structuredCompactionOwners.delete(owner.ownerKey);
    }
    if (failed && !run.retainFailedResult && structuredCompactionRuns.get(key) === run) structuredCompactionRuns.delete(key);
  });
  const run: CachedCompactionRun = {
    createdAt: Date.now(),
    ...registrations,
    ...(owner.requestDigest ? { requestDigest: owner.requestDigest } : {}),
    abort,
    promise,
    settlement: ownerSettlement,
    ...(owner.retainFailedResult ? { retainFailedResult: true } : {}),
  };
  structuredCompactionRuns.set(key, run);
  structuredCompactionOwners.set(owner.ownerKey, ownerSettlement);
  return promise;
}

function beginCancelStructuredCompactionRuns(
  matches: (run: CachedCompactionRun) => boolean,
  reason: Error,
): { cancelled: number; settlement: Promise<void> } {
  const runs = [...structuredCompactionRuns.values()].filter(run => run.active && matches(run));
  for (const run of runs) {
    if (!run.abort.signal.aborted) run.abort.abort(reason);
  }
  return { cancelled: runs.length, settlement: Promise.allSettled(runs.map(run => run.settlement)).then(() => undefined) };
}

/** Begin cancelling the structured compaction owned by one exact native Codex turn. */
export function cancelStructuredCompactionNativeTurn(
  threadId: string,
  turnId: string,
  reason: Error,
): { cancelled: number; settlement: Promise<void> } {
  // Record before scanning active owners. Registration and cancellation share this synchronous
  // boundary, so either registration wins and is aborted below, or interruption wins and the later
  // registration rejects without invoking its detached work.
  rememberStructuredCompactionInterruption(threadId, turnId, reason);
  const runs = [...structuredCompactionRuns.values()].filter(run => (
    run.active
    && run.nativeTurnIdentities.has(nativeTurnIdentityKey(threadId, turnId))
  ));
  for (const run of runs) {
    if (!run.abort.signal.aborted) run.abort.abort(reason);
  }
  return {
    cancelled: runs.length,
    settlement: Promise.allSettled(runs.map(run => run.settlement)).then(() => undefined),
  };
}

/** Cancel a user-requested compaction without treating an HTTP observer disconnect as terminal. */
export function beginCancelStructuredCompactionTrace(traceId: string, reason: Error): { cancelled: number; settlement: Promise<void> } {
  return beginCancelStructuredCompactionRuns(run => run.traceIds.has(traceId), reason);
}

export async function cancelStructuredCompactionTrace(traceId: string, reason: Error): Promise<number> {
  const cancellation = beginCancelStructuredCompactionTrace(traceId, reason);
  await cancellation.settlement;
  return cancellation.cancelled;
}

/** Cancel every active compaction owner and wait for its browser/helper cleanup. */
export async function cancelAllStructuredCompactions(reason: Error): Promise<number> {
  const cancellation = beginCancelStructuredCompactionRuns(() => true, reason);
  await cancellation.settlement;
  return cancellation.cancelled;
}
