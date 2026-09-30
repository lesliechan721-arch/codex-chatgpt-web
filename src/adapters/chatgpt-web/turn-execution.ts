import { createHash } from "node:crypto";
import { type AdapterEvent, type CodexParsedRequest, type CodexToolResultMessage } from "../../types";
import { COMPACT_PROMPT, isReadableCompactionSummaryText } from "../../responses/compaction";
import { parseRequest } from "../../responses/parser";
import { canonicalJson } from "./canonical-json";
import type { BrokerToolRequest } from "./turn-broker";
import { ChatGptWebAdapterError, chatGptBrowserTabClosedError, chatGptTurnSupersededError } from "./adapter-error";
import {
  chatGptCurrentInstructionIndex,
  chatGptCurrentInstructionRevision,
  chatGptInstructionContent,
  chatGptInstructionEnvelope,
  chatGptTurnUserRevisionHistory,
  continuityCurrentInstructionInput,
  extractChatGptCompactionSourceRevision,
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
  hasNativeChatGptInstruction,
} from "./environment";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import { continuityError } from "./continuity-errors";
import {
  continuityCheckpoint,
  continuityDigest,
  retainContinuityOrdinaryReplayTombstone,
  type ContinuityBinding,
  type ContinuityToolResultReplayEvidence,
} from "./continuity-binding";
import { CONTINUITY_IDLE_TTL_MS } from "./continuity-contract";
import type { ChatGptExternalTurnProgress } from "./turn-progress";

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // Keep the underlying retirement promise observed even when the caller arrived after abort;
    // another owner may still depend on its eventual settlement and rejection must not become an
    // unhandled process-level error.
    void promise.catch(() => {});
    return Promise.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
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

export type ChatGptBrowserOutcome =
  | { type: "final"; answer: string }
  | { type: "error"; error: Error };

export interface ChatGptTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface TraceWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ChatGptTraceFeed {
  private readonly queued: ChatGptTraceEvent[] = [];
  private readonly waiters = new Set<TraceWaiter>();
  private readonly observers = new Set<() => void>();

  push(event: ChatGptTraceEvent): void {
    const normalized = event.continuation ? event.text : event.text.trim();
    if (!normalized) return;
    const normalizedEvent = { ...event, text: normalized };
    this.queued.push(normalizedEvent);
    for (const observer of this.observers) observer();
    const waiter = this.waiters.values().next().value as TraceWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): ChatGptTraceEvent[] {
    return this.queued.splice(0);
  }

  observe(observer: () => void): () => void {
    this.observers.add(observer);
    if (this.queued.length > 0) observer();
    return () => this.observers.delete(observer);
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("trace wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TraceWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("trace wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface TextWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Append-only browser Markdown feed. Waiters are notifications; `drain` owns consumption. */
export class ChatGptTextFeed {
  private readonly queued: string[] = [];
  private readonly waiters = new Set<TextWaiter>();
  private readonly observers = new Set<() => void>();
  private text = "";

  push(delta: string): void {
    if (!delta) return;
    this.text += delta;
    this.queued.push(delta);
    for (const observer of this.observers) observer();
    const waiter = this.waiters.values().next().value as TextWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): string[] {
    return this.queued.splice(0);
  }

  observe(observer: () => void): () => void {
    this.observers.add(observer);
    if (this.queued.length > 0) observer();
    return () => this.observers.delete(observer);
  }

  value(): string {
    return this.text;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("text wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TextWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("text wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface ChatGptTurnRuntimeBase {
  browser: Promise<string>;
  /** Physical helper/Playwright settlement, including the launcher end/release acknowledgement. */
  physicalSettlement: Promise<void>;
  trace: ChatGptTraceFeed;
  text: ChatGptTextFeed;
  usageInput?: CodexParsedRequest;
  /** The live binding owns the ready-page clock; replay and queries never renew it. */
  continuityBinding?: ContinuityBinding;
  conversationKey?: string;
  releaseRetainedConversation?: () => Promise<void>;
  /** Idempotently retire the turn-bound MCP capability after browser and observer settlement. */
  retireCapability?: () => void | Promise<void>;
  submission?: { phase: "prepared" | "send_activated" | "accepted" };
  /** Present only when the visible ChatGPT tab is driven manually through the Codex Zero Risk2 MCP contract. */
  manualControl?: { surfaceNonce: string };
  cancel: (reason?: Error) => void;
}

export type ChatGptTurnRuntime =
  | (ChatGptTurnRuntimeBase & {
    mode: "tools";
    token: Promise<string>;
    externalProgress: ChatGptExternalTurnProgress;
  })
  | (ChatGptTurnRuntimeBase & { mode: "read-only" });

function executionKey(parsed: CodexParsedRequest, payload: unknown): string {
  const continuity = parsed._conversationPolicy === "continuity-first";
  if (continuity && (!Number.isSafeInteger(parsed._continuityHistoryRevision)
    || parsed._continuityHistoryRevision! < 0)) throw continuityError("continuity_source_unproven");
  return createHash("sha256").update(canonicalJson({
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    ...(continuity ? {
      policy: "continuity-first", historyRevision: parsed._continuityHistoryRevision,
      modelFamily: parsed._chatgptModelFamily,
    } : {}),
    payload,
  })).digest("hex");
}

function compactionInputRevision(parsed: CodexParsedRequest): unknown[] {
  const body = parsed._rawBody;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex request body");
  }
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex input history");
  }
  return input;
}

function canonicalMessageId(parsed: CodexParsedRequest, itemId: string | undefined): string | undefined {
  if (!itemId) return undefined;
  const alias = parsed._chatGptMessageIdAliases?.[itemId];
  return typeof alias === "string" && alias.length > 0 ? alias : itemId;
}

export function continuityInstructionIdentity(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  const revision = chatGptCurrentInstructionRevision(parsed);
  if (!identity.turnId || !revision) throw continuityError("continuity_source_unproven");
  return canonicalMessageId(parsed, revision.itemId) ?? `turn:${identity.turnId}`;
}

export interface ChatGptContinuityInstructionPrevious {
  instructionIdentity?: string;
  nativeTurnId?: string;
  checkpointDigest?: string;
}

export interface ContinuitySourceInstructionReplayEvidence {
  instructionIdentity: string;
  nativeTurnId?: string;
  previous?: ChatGptContinuityInstructionPrevious;
  allowRetainedSourceFallback: boolean;
  contentDigest: string;
  sourceDigest: string;
}

function continuityInstructionSelectionPrevious(
  parsed: CodexParsedRequest,
  previous?: ChatGptContinuityInstructionPrevious,
): { instructionIdentity?: string; nativeTurnId?: string; trustedLowerBound?: number } | undefined {
  if (!previous) return undefined;
  const selection = {
    instructionIdentity: previous.instructionIdentity,
    nativeTurnId: previous.nativeTurnId,
  };
  if (!previous.checkpointDigest) return selection;
  const checkpoint = continuityCheckpoint(parsed);
  return checkpoint.index >= 0 && checkpoint.digest === previous.checkpointDigest
    ? { ...selection, trustedLowerBound: checkpoint.index }
    : selection;
}

function continuityInstructionPayloadContents(
  parsed: CodexParsedRequest,
  previous?: ChatGptContinuityInstructionPrevious,
  allowRetainedSourceFallback = false,
): unknown[] {
  // Later compaction recovery must not remove an instruction from its already accepted work set.
  const selected = continuityCurrentInstructionInput(
    parsed,
    continuityInstructionSelectionPrevious(parsed, previous),
    !allowRetainedSourceFallback,
  );
  const contents = selected.map(value => {
    const item = rawRecord(value);
    if (!item) throw continuityError("continuity_source_unproven");
    return { ...chatGptInstructionEnvelope(item), content: chatGptInstructionContent(item) };
  });
  if (hasNativeChatGptInstruction(parsed, selected) || (contents.length > 0 && !allowRetainedSourceFallback)) return contents;
  if (!allowRetainedSourceFallback) throw continuityError("continuity_source_unproven");
  const retained = chatGptCurrentInstructionRevision(parsed);
  if (!retained) throw continuityError("continuity_source_unproven");
  return [{ ...(retained.instructionEnvelope ?? { role: "user" }), content: retained.content }, ...contents];
}

export function chatGptContinuityInstructionPayloadDigest(
  parsed: CodexParsedRequest,
  previous?: ChatGptContinuityInstructionPrevious,
  allowRetainedSourceFallback = false,
): string {
  const contents = continuityInstructionPayloadContents(parsed, previous, allowRetainedSourceFallback);
  const { reasoning: _reasoning, promptCacheKey: _promptCacheKey, ...options } = parsed.options;
  const raw = rawRecord(parsed._rawBody);
  const instructions = typeof raw?.instructions === "string" && raw.instructions.length > 0
    ? raw.instructions
    : null;
  return createHash("sha256").update(canonicalJson({ contents, instructions, options })).digest("hex");
}

function rawRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rawMessageText(item: Record<string, unknown>): string {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content.map(value => {
    const part = rawRecord(value);
    return typeof part?.text === "string" ? part.text : "";
  }).join("\n");
}

function isContinuityCheckpointBoundary(item: Record<string, unknown>): boolean {
  if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) return true;
  return item.role === "user" && isReadableCompactionSummaryText(rawMessageText(item));
}

function activeToolResultMatches(item: Record<string, unknown>, request: BrokerToolRequest): boolean {
  if (item.call_id !== request.callId) return false;
  if (request.wireName === "tool_search") return item.type === "tool_search_output";
  return item.type === (request.freeform ? "custom_tool_call_output" : "function_call_output");
}

function continuityInstructionContentDigest(
  parsed: CodexParsedRequest,
  previous?: ChatGptContinuityInstructionPrevious,
  allowRetainedSourceFallback = false,
): string {
  return createHash("sha256")
    .update(canonicalJson(continuityInstructionPayloadContents(parsed, previous, allowRetainedSourceFallback)))
    .digest("hex");
}

export function assertContinuitySourceInstructionReplay(
  parsed: CodexParsedRequest,
  evidence: ContinuitySourceInstructionReplayEvidence,
): void {
  if (continuityInstructionContentDigest(parsed, evidence.previous, evidence.allowRetainedSourceFallback)
    !== evidence.contentDigest) {
    throw continuityError("continuity_source_unproven", "The compaction source instruction does not match the accepted current work.");
  }
}

export function chatGptContinuityCompactionRequestDigest(
  parsed: CodexParsedRequest,
  results: ContinuityToolResultReplayEvidence,
): string {
  if (!parsed._compactionRequest) throw continuityError("continuity_source_unproven");
  const source = extractChatGptCompactionSourceRevision(parsed);
  let control = COMPACT_PROMPT;
  if (parsed._compactionOutput === "message") {
    const message = parsed.context.messages.at(-1);
    if (message?.role !== "user") throw continuityError("continuity_source_unproven");
    control = typeof message.content === "string"
      ? message.content
      : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    if (!control.trim()) throw continuityError("continuity_source_unproven");
  }
  return createHash("sha256").update(canonicalJson({
    source: { turnId: source.turnId ?? null, itemId: canonicalMessageId(parsed, source.itemId) ?? null, content: source.content },
    control,
    results: { results: results.results },
  })).digest("hex");
}

function toolResultPayloadDigest(item: Record<string, unknown>): string {
  const payload = item.type === "tool_search_output"
    ? {
      type: item.type,
      call_id: item.call_id,
      status: typeof item.status === "string" ? item.status : null,
      tools: Array.isArray(item.tools) ? item.tools : [],
    }
    : {
      type: item.type,
      call_id: item.call_id,
      output: item.output ?? item.content ?? null,
    };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function assertContinuityToolResultReplayEvidence(
  parsed: CodexParsedRequest,
  evidence: ContinuityToolResultReplayEvidence,
): void {
  const expected = new Map(evidence.results.map(result => [result.callId, result]));
  if (expected.size !== evidence.results.length) throw continuityError("continuity_source_unproven");
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) throw continuityError("continuity_source_unproven");
  const lowerBound = chatGptCurrentInstructionIndex(parsed) + 1;
  const seen = new Set<string>();
  for (let index = input.length - 1; index >= lowerBound; index -= 1) {
    const item = rawRecord(input[index]);
    if (!item) continue;
    if (isContinuityCheckpointBoundary(item)) {
      if (seen.size === expected.size) break;
      throw continuityError("continuity_source_unproven", "The retained compaction result batch crosses a committed checkpoint boundary.");
    }
    const callId = typeof item.call_id === "string" ? item.call_id : undefined;
    const outputType = item.type === "function_call_output"
      || item.type === "custom_tool_call_output"
      || item.type === "tool_search_output";
    if (!outputType) {
      if (callId && expected.has(callId)
        && !["function_call", "custom_tool_call", "tool_search_call"].includes(String(item.type))) {
        throw continuityError("continuity_source_unproven", `Tool result ${callId} has an invalid result type.`);
      }
      continue;
    }
    if (!callId) throw continuityError("continuity_source_unproven", "A terminal tool result has no call_id.");
    const retained = expected.get(callId);
    if (!retained) {
      if (seen.size === expected.size && expected.size > 0 && evidence.earlierCallIds?.includes(callId)) break;
      throw continuityError("continuity_source_unproven", "A terminal tool result does not belong to the retained compaction result batch.");
    }
    if (seen.has(callId)) {
      throw continuityError("continuity_source_unproven", "The retained compaction result batch is duplicated.");
    }
    if (item.type !== retained.type || toolResultPayloadDigest(item) !== retained.digest) {
      throw continuityError("continuity_source_unproven", `Tool result ${callId} conflicts with its first accepted payload.`);
    }
    seen.add(callId);
  }
  if (seen.size !== expected.size) {
    throw continuityError(
      "continuity_source_unproven",
      `Codex supplied ${seen.size} of ${expected.size} retained compaction tool results.`,
    );
  }
}

interface ContinuityToolBatch {
  readonly id: number;
  readonly requests: BrokerToolRequest[];
  readonly requestById: Map<string, BrokerToolRequest>;
  readonly resultRoundKey: string;
  acceptedResultDigests?: Map<string, string>;
  readonly delivered: Set<string>;
  readonly previousCallIds: readonly string[];
}

export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  if (parsed._conversationPolicy === "continuity-first") {
    if (parsed._compactionRequest) {
      const source = extractChatGptCompactionSourceRevision(parsed);
      return executionKey(parsed, {
        threadId: identity.threadId,
        turnId: source.turnId ?? parsed._chatGptCompactionSourceTurnId ?? identity.turnId,
        purpose: "compaction",
        instructionId: canonicalMessageId(parsed, source.itemId) ?? `turn:${source.turnId ?? identity.turnId}`,
      });
    }
    return executionKey(parsed, {
      threadId: identity.threadId,
      turnId: identity.turnId,
      purpose: "response",
      instructionId: continuityInstructionIdentity(parsed),
    });
  }
  const currentRevision = chatGptTurnUserRevisionHistory(parsed).at(-1);
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
    revision: parsed._compactionRequest
      ? compactionInputRevision(parsed)
      : extractChatGptTurnUserRevision(parsed),
    ...(!parsed._compactionRequest ? { instructionId: canonicalMessageId(parsed, currentRevision?.itemId) } : {}),
  });
}

export interface ChatGptInstructionLineage {
  current: string;
  predecessors: ReadonlySet<string>;
}

export function chatGptInstructionLineage(parsed: CodexParsedRequest): ChatGptInstructionLineage {
  const revisions = chatGptTurnUserRevisionHistory(parsed).map(revision => createHash("sha256")
    .update(JSON.stringify([canonicalMessageId(parsed, revision.itemId) ?? null, revision.content])).digest("hex"));
  const current = revisions.pop();
  if (!current) throw new Error("ChatGPT web requires a canonical user instruction");
  return { current, predecessors: new Set(revisions) };
}

/** Exact canonical Responses request identity inside one long-lived browser execution. */
export function chatGptTurnRoundKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for round replay");
  if (parsed._conversationPolicy === "continuity-first") {
    return executionKey(parsed, {
      threadId: identity.threadId,
      turnId: identity.turnId,
      purpose: parsed._compactionRequest ? "compaction" : "response",
      round: "ordinary",
      instructionId: continuityInstructionIdentity(parsed),
    });
  }
  const body = parsed._rawBody;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Array.isArray((body as { input?: unknown }).input)) {
    throw new Error("ChatGPT web requires the complete native Codex input for round replay");
  }
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
    input: (body as { input: unknown[] }).input,
  });
}

/** Stable identity for limiting automatic retries of one native Codex turn. */
export function chatGptTurnRetryKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-turn retry budgeting");
  return createHash("sha256").update(JSON.stringify({
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
  })).digest("hex");
}

/** One native Codex thread may own at most one live ChatGPT browser surface. */
export function chatGptThreadOwnershipKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  const owner = identity.threadId
    ? { kind: "thread", id: identity.threadId }
    : identity.promptCacheKey
      ? { kind: "prompt_cache", id: identity.promptCacheKey }
      : identity.turnId
        ? { kind: "turn", id: identity.turnId }
        : undefined;
  if (!owner) throw new Error("ChatGPT web requires native Codex turn identity metadata for browser ownership");
  return createHash("sha256").update(JSON.stringify(owner)).digest("hex");
}

/** Locate the browser response that a native mid-turn compaction replaces. */
export function chatGptCompactionSourceExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const source = extractChatGptCompactionSourceRevision(parsed);
  if (parsed._conversationPolicy === "continuity-first") {
    return executionKey({ ...parsed, _continuityHistoryRevision: parsed._continuityHistoryRevision }, {
      threadId: identity.threadId,
      turnId: source.turnId ?? parsed._chatGptCompactionSourceTurnId ?? identity.turnId,
      purpose: "response",
      instructionId: canonicalMessageId(parsed, source.itemId) ?? `turn:${source.turnId ?? identity.turnId}`,
    });
  }
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: source.turnId ?? parsed._chatGptCompactionSourceTurnId ?? identity.turnId,
    purpose: "response",
    revision: source.content,
    instructionId: canonicalMessageId(parsed, source.itemId),
  });
}

/** Delegated authority accepts only request-carried native source identity; rollout aliases are not authority. */
export function chatGptDelegatedCompactionSourceExecutionKey(parsed: CodexParsedRequest): string | undefined {
  if (!parsed._compactionRequest) return undefined;
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) return undefined;
  let source: ReturnType<typeof extractChatGptCompactionSourceRevision>;
  try {
    source = extractChatGptCompactionSourceRevision(parsed);
  } catch {
    return undefined;
  }
  if (!source.turnId || !source.itemId) return undefined;
  if (parsed._conversationPolicy === "continuity-first") {
    return executionKey(parsed, {
      threadId: identity.threadId,
      turnId: source.turnId,
      purpose: "response",
      instructionId: source.itemId,
    });
  }
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: source.turnId,
    purpose: "response",
    revision: source.content,
    instructionId: source.itemId,
  });
}

export class ChatGptTurnSession {
  supersededError?: Error;
  readonly createdAt = Date.now();
  private lastTouchedAt = this.createdAt;
  readonly browserOutcome: Promise<ChatGptBrowserOutcome>;
  readonly physicalSettlement: Promise<void>;
  private readonly outstandingById = new Map<string, BrokerToolRequest>();
  private outstandingReasoning: string[] = [];
  private finalReasoning: string[] = [];
  private outstandingPrelude: AdapterEvent[] = [];
  private finalPrelude: AdapterEvent[] = [];
  private settledBrowserOutcome?: ChatGptBrowserOutcome;
  private settledPhysical = false;
  private attachedConversationKey: string | undefined;
  private canonicalInputValue?: unknown[];
  private acceptedInstructionIdentity?: string;
  private acceptedInstructionPayloadDigest?: string;
  private acceptedInstructionContentDigest?: string;
  private acceptedInstructionSourceDigest?: string;
  private acceptedInstructionPrevious?: ChatGptContinuityInstructionPrevious;
  private acceptedInstructionAllowsRetainedSourceFallback = false;
  private continuityOrdinaryRoundKey?: string;
  private continuityGeneration = 0;
  private nextToolBatchId = 1;
  private readonly toolBatches = new Map<number, ContinuityToolBatch>();
  private readonly toolBatchByCallId = new Map<string, ContinuityToolBatch>();
  private tail: Promise<void> = Promise.resolve();
  private capabilityRetirementScheduled = false;
  private readonly rounds = new Map<string, {
    events: AdapterEvent[];
    reasoning: string[];
    completed: boolean;
    failure?: Error;
  }>();

  constructor(
    readonly runtime: ChatGptTurnRuntime,
    readonly traceId?: string,
    readonly ownerKey?: string,
    readonly nativeTurnId?: string,
    readonly nativeThreadId?: string,
    readonly instruction?: string,
  ) {
    this.attachedConversationKey = runtime.conversationKey;
    this.physicalSettlement = runtime.physicalSettlement.then(
      () => { this.settledPhysical = true; },
      error => {
        this.settledPhysical = true;
        throw error;
      },
    );
    this.browserOutcome = runtime.browser
      .then(answer => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(error => ({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }) as ChatGptBrowserOutcome)
      .then(outcome => {
      this.settledBrowserOutcome = outcome;
      if (runtime.continuityBinding) this.lastTouchedAt = runtime.continuityBinding.lastUsedAt;
      const error = outcome.type === "error" && outcome.error instanceof ChatGptWebAdapterError
        ? outcome.error : undefined;
      console.info(`[chatgpt-web] browser_settled ${JSON.stringify({
        traceId: this.traceId,
        outcome: outcome.type,
        compaction: runtime.usageInput?._compactionRequest === true,
        ...(!runtime.usageInput?._compactionRequest ? { submission: runtime.submission?.phase ?? "unknown" } : {}),
        ...(error ? { code: error.code, retryable: error.retryable } : {}),
      })}`);
      return outcome;
    });
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.touch();
    const run = this.tail.then(task);
    this.tail = run.then(() => undefined, () => undefined);
    this.scheduleCapabilityRetirement();
    return run;
  }

  touch(): void {
    if (!this.runtime.continuityBinding) this.lastTouchedAt = Date.now();
  }

  lastUsedAt(): number {
    return this.lastTouchedAt;
  }

  outstanding(): BrokerToolRequest[] {
    return [...this.outstandingById.values()];
  }

  settledOutcome(): ChatGptBrowserOutcome | undefined {
    return this.settledBrowserOutcome;
  }

  acceptCanonicalInput(
    parsed: CodexParsedRequest,
    previous?: ChatGptContinuityInstructionPrevious,
    allowRetainedSourceFallback = false,
  ): void {
    const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
    if (!Array.isArray(input)) throw continuityError("continuity_source_unproven");
    const instructionIdentity = continuityInstructionIdentity(parsed);
    const acceptedPrevious = this.acceptedInstructionPayloadDigest === undefined
      ? previous
      : this.acceptedInstructionPrevious;
    const acceptedAllowRetainedSourceFallback = this.acceptedInstructionPayloadDigest === undefined
      ? allowRetainedSourceFallback
      : this.acceptedInstructionAllowsRetainedSourceFallback;
    const payload = chatGptContinuityInstructionPayloadDigest(
      parsed,
      acceptedPrevious,
      acceptedAllowRetainedSourceFallback,
    );
    const content = continuityInstructionContentDigest(
      parsed,
      acceptedPrevious,
      acceptedAllowRetainedSourceFallback,
    );
    if (this.acceptedInstructionIdentity !== undefined && this.acceptedInstructionIdentity !== instructionIdentity) {
      throw continuityError("continuity_source_unproven");
    }
    if (this.acceptedInstructionPayloadDigest !== undefined && this.acceptedInstructionPayloadDigest !== payload) {
      throw continuityError("continuity_source_unproven", "The accepted native instruction identity now carries a different current payload.");
    }
    if (this.acceptedInstructionPayloadDigest === undefined) {
      this.acceptedInstructionIdentity = instructionIdentity;
      this.acceptedInstructionPayloadDigest = payload;
      this.acceptedInstructionContentDigest = content;
      const source = chatGptCurrentInstructionRevision(parsed)!;
      this.acceptedInstructionSourceDigest = continuityDigest({ turnId: source.turnId ?? null,
        ...(source.instructionEnvelope ?? { role: "user" }), content: source.content });
      this.acceptedInstructionPrevious = previous ? { ...previous } : undefined;
      this.acceptedInstructionAllowsRetainedSourceFallback = allowRetainedSourceFallback;
      this.continuityOrdinaryRoundKey = chatGptTurnRoundKey(parsed);
      this.continuityGeneration += 1;
    }
    this.canonicalInputValue = structuredClone(input);
  }

  assertCanonicalReplayInput(parsed: CodexParsedRequest): void {
    if (!this.acceptedInstructionIdentity || !this.acceptedInstructionPayloadDigest || !this.acceptedInstructionContentDigest) {
      throw continuityError("continuity_source_unproven");
    }
    if (continuityInstructionIdentity(parsed) !== this.acceptedInstructionIdentity
      || chatGptContinuityInstructionPayloadDigest(
        parsed,
        this.acceptedInstructionPrevious,
        this.acceptedInstructionAllowsRetainedSourceFallback,
      ) !== this.acceptedInstructionPayloadDigest) {
      throw continuityError("continuity_source_unproven", "The accepted native instruction identity now carries a different current payload.");
    }
  }

  acceptedContinuityInstructionIdentity(): string | undefined {
    return this.acceptedInstructionIdentity;
  }

  assertContinuitySourceInstruction(parsed: CodexParsedRequest): void {
    assertContinuitySourceInstructionReplay(parsed, this.continuitySourceInstructionReplayEvidence());
  }

  continuitySourceInstructionReplayEvidence(): ContinuitySourceInstructionReplayEvidence {
    if (!this.acceptedInstructionIdentity || !this.acceptedInstructionContentDigest || !this.acceptedInstructionSourceDigest) {
      throw continuityError("continuity_source_unproven");
    }
    return {
      instructionIdentity: this.acceptedInstructionIdentity,
      nativeTurnId: this.nativeTurnId,
      previous: this.acceptedInstructionPrevious ? { ...this.acceptedInstructionPrevious } : undefined,
      allowRetainedSourceFallback: this.acceptedInstructionAllowsRetainedSourceFallback,
      contentDigest: this.acceptedInstructionContentDigest,
      sourceDigest: this.acceptedInstructionSourceDigest,
    };
  }

  continuityGenerationValue(): number {
    return this.continuityGeneration;
  }

  assertContinuityGeneration(expected: number): void {
    if (expected !== this.continuityGeneration) {
      throw continuityError("continuity_source_unproven", "The compaction source advanced after preflight.");
    }
  }

  continuityRoundKey(parsed: CodexParsedRequest): string {
    return this.continuityToolResultRoundKey(parsed) ?? chatGptTurnRoundKey(parsed);
  }

  continuityToolResultRoundKey(parsed: CodexParsedRequest): string | undefined {
    return this.resolveContinuityToolBatch(parsed)?.batch.resultRoundKey;
  }

  assertContinuityCompactionResultBatch(parsed: CodexParsedRequest): void {
    const resolved = this.resolveContinuityToolBatch(parsed);
    const outstanding = this.outstanding();
    if (outstanding.length === 0) return;
    if (!resolved || outstanding.some(request => !resolved.batch.requestById.has(request.callId))) {
      throw continuityError(
        "continuity_source_unproven",
        "Active compaction requires one complete terminal result group for the current local tool batch.",
      );
    }
  }

  assertContinuityToolResultReplay(parsed: CodexParsedRequest): void {
    this.resolveContinuityToolBatch(parsed);
  }

  continuityToolResultReplayEvidence(parsed: CodexParsedRequest): ContinuityToolResultReplayEvidence {
    const resolved = this.resolveContinuityToolBatch(parsed);
    if (!resolved) return { results: [] };
    return {
      earlierCallIds: resolved.earlierCallIds,
      results: resolved.batch.requests.map(request => {
        const item = resolved.rawResults.get(request.callId);
        if (!item || typeof item.type !== "string") throw continuityError("continuity_source_unproven");
        return {
          callId: request.callId,
          type: item.type,
          digest: toolResultPayloadDigest(item),
        };
      }),
    };
  }

  continuityToolSearchResults(parsed: CodexParsedRequest): Record<string, unknown>[] {
    const resolved = this.resolveContinuityToolBatch(parsed);
    // An accepted batch is replay evidence, not a new registry publication.
    return resolved && !resolved.batch.acceptedResultDigests
      ? [...resolved.rawResults.values()].filter(item => item.type === "tool_search_output") : [];
  }

  canonicalInput(): unknown[] | undefined {
    return this.canonicalInputValue ? structuredClone(this.canonicalInputValue) : undefined;
  }

  acceptContinuityToolResults(parsed: CodexParsedRequest): CodexToolResultMessage[] {
    const resolved = this.resolveContinuityToolBatch(parsed);
    if (!resolved) return [];
    const { batch, rawResults, messages } = resolved;
    const digests = new Map([...rawResults].map(([callId, item]) => [callId, toolResultPayloadDigest(item)]));
    if (batch.acceptedResultDigests) {
      for (const [callId, digest] of digests) {
        if (batch.acceptedResultDigests.get(callId) !== digest) {
          throw continuityError("continuity_source_unproven", `Tool result ${callId} conflicts with its first accepted payload.`);
        }
      }
    } else {
      batch.acceptedResultDigests = digests;
      this.continuityGeneration += 1;
    }
    return batch.requests.flatMap(request => batch.delivered.has(request.callId)
      ? []
      : [messages.get(request.callId)!]);
  }

  private resolveContinuityToolBatch(parsed: CodexParsedRequest): {
    batch: ContinuityToolBatch;
    rawResults: Map<string, Record<string, unknown>>;
    messages: Map<string, CodexToolResultMessage>;
    earlierCallIds: string[];
  } | undefined {
    const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
    if (!Array.isArray(input)) throw continuityError("continuity_source_unproven");
    const lowerBound = chatGptCurrentInstructionIndex(parsed) + 1;
    let batch: ContinuityToolBatch | undefined;
    const rawResults = new Map<string, Record<string, unknown>>();
    const earlierCallIds = new Set<string>();
    for (let index = input.length - 1; index >= lowerBound; index -= 1) {
      const item = rawRecord(input[index]);
      if (!item) continue;
      if (isContinuityCheckpointBoundary(item)) {
        if (!batch) return undefined;
        if (rawResults.size === batch.requests.length) break;
        throw continuityError("continuity_source_unproven", "The current local tool batch crosses a committed checkpoint boundary.");
      }
      const callId = typeof item.call_id === "string" ? item.call_id : undefined;
      const outputType = item.type === "function_call_output"
        || item.type === "custom_tool_call_output"
        || item.type === "tool_search_output";
      if (!outputType) {
        if (callId && this.toolBatchByCallId.has(callId)
          && !["function_call", "custom_tool_call", "tool_search_call"].includes(String(item.type))) {
          throw continuityError("continuity_source_unproven", `Tool result ${callId} has an invalid result type.`);
        }
        continue;
      }
      if (!callId) throw continuityError("continuity_source_unproven", "A terminal tool result has no call_id.");
      const candidate = this.toolBatchByCallId.get(callId);
      if (!candidate) {
        // Retain only the immediate predecessor's issued IDs with each bounded batch.
        // Reclaiming its journal must not make current results authenticate older history.
        if (batch && rawResults.size === batch.requests.length && batch.previousCallIds.includes(callId)) break;
        throw continuityError("continuity_source_unproven", "A terminal tool result does not belong to a retained local batch.");
      }
      if (!batch) {
        batch = candidate;
        for (const id of batch.previousCallIds) earlierCallIds.add(id);
      }
      if (candidate !== batch) {
        if (candidate.id < batch.id && rawResults.size === batch.requests.length) {
          for (const request of candidate.requests) earlierCallIds.add(request.callId);
          break;
        }
        throw continuityError("continuity_source_unproven", "The current result group mixes more than one local tool batch.");
      }
      const request = batch.requestById.get(callId)!;
      if (!activeToolResultMatches(item, request) || rawResults.has(callId)) {
        throw continuityError("continuity_source_unproven", "The current tool batch is incomplete, duplicated, or has the wrong result type.");
      }
      rawResults.set(callId, item);
    }
    if (!batch) return undefined;
    if (rawResults.size !== batch.requests.length) {
      throw continuityError("continuity_source_unproven", `Codex supplied ${rawResults.size} of ${batch.requests.length} required results for the current local tool batch.`);
    }
    const messages = new Map<string, CodexToolResultMessage>();
    const selectedResults = batch.requests.map(request => rawResults.get(request.callId)!);
    for (const message of parseRequest({ model: parsed.modelId, input: selectedResults }).context.messages) {
      if (message.role !== "toolResult" || !batch.requestById.has(message.toolCallId)) continue;
      if (messages.has(message.toolCallId)) {
        throw continuityError("continuity_source_unproven", `Codex returned duplicate parsed results for tool call ${message.toolCallId}.`);
      }
      messages.set(message.toolCallId, message);
    }
    if (messages.size !== batch.requests.length) {
      throw continuityError("continuity_source_unproven", "The current raw tool batch could not be mapped to one complete parsed result group.");
    }
    if (batch.acceptedResultDigests) {
      for (const [callId, item] of rawResults) {
        if (batch.acceptedResultDigests.get(callId) !== toolResultPayloadDigest(item)) {
          throw continuityError("continuity_source_unproven", `Tool result ${callId} conflicts with its first accepted payload.`);
        }
      }
    }
    return { batch, rawResults, messages, earlierCallIds: [...earlierCallIds] };
  }

  conversationKey(): string | undefined {
    return this.attachedConversationKey;
  }

  detachConversation(conversationKey: string): boolean {
    if (this.attachedConversationKey !== conversationKey) return false;
    this.attachedConversationKey = undefined;
    return true;
  }

  isActive(): boolean {
    return this.settledBrowserOutcome === undefined;
  }

  /** The client-visible browser result can settle before launcher/helper cleanup does. */
  isPhysicallySettled(): boolean {
    return this.settledPhysical;
  }

  setOutstanding(requests: BrokerToolRequest[], reasoning: string[] = [], prelude: AdapterEvent[] = []): void {
    if (this.outstandingById.size > 0) throw new Error("cannot emit a new ChatGPT tool batch while the previous batch is unresolved");
    let batch: ContinuityToolBatch | undefined;
    if (this.runtime.continuityBinding) {
      const batchId = this.nextToolBatchId++;
      batch = {
        id: batchId,
        requests: [...requests],
        requestById: new Map(requests.map(request => [request.callId, request])),
        resultRoundKey: `tool-batch:${batchId}`,
        delivered: new Set(),
        previousCallIds: [...this.toolBatches.values()].at(-1)?.requests.map(request => request.callId) ?? [],
      };
    }
    for (const request of requests) {
      if (this.toolBatchByCallId.has(request.callId) || this.outstandingById.has(request.callId)) {
        throw new Error(`duplicate ChatGPT bridge tool call id: ${request.callId}`);
      }
      this.outstandingById.set(request.callId, request);
      if (batch) this.toolBatchByCallId.set(request.callId, batch);
    }
    if (batch) this.toolBatches.set(batch.id, batch);
    this.outstandingReasoning = [...reasoning];
    this.outstandingPrelude = [...prelude];
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string): void {
    if (!this.outstandingById.delete(callId)) throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    const batch = this.toolBatchByCallId.get(callId);
    if (batch) batch.delivered.add(callId);
    else if (this.runtime.continuityBinding) throw new Error(`ChatGPT bridge tool result lost its local batch: ${callId}`);
    if (this.outstandingById.size === 0) {
      this.outstandingReasoning = [];
      this.outstandingPrelude = [];
    }
  }

  reasoningForOutstandingReplay(): string[] {
    return [...this.outstandingReasoning];
  }

  eventsForOutstandingReplay(): AdapterEvent[] {
    return [...this.outstandingPrelude];
  }

  setFinalReasoning(reasoning: string[]): void {
    this.finalReasoning = [...reasoning];
  }

  reasoningForFinalReplay(): string[] {
    return [...this.finalReasoning];
  }

  setFinalEvents(events: AdapterEvent[]): void {
    this.finalPrelude = [...events];
  }

  eventsForFinalReplay(): AdapterEvent[] {
    return [...this.finalPrelude];
  }

  roundEvents(key: string): AdapterEvent[] {
    return [...this.round(key).events];
  }

  roundReasoning(key: string): string[] {
    return [...this.round(key).reasoning];
  }

  appendRoundEvent(key: string, event: AdapterEvent): void {
    this.appendRoundEvents(key, [event]);
  }

  appendRoundEvents(key: string, events: readonly AdapterEvent[]): void {
    if (events.length === 0) return;
    const round = this.round(key);
    if (round.completed) throw new Error("cannot append to a completed ChatGPT native round");
    round.events.push(...events);
  }

  appendRoundReasoning(key: string, values: readonly string[]): void {
    if (values.length === 0) return;
    const round = this.round(key);
    if (round.completed) throw new Error("cannot append reasoning to a completed ChatGPT native round");
    round.reasoning.push(...values);
  }

  completeRound(key: string): void {
    this.round(key).completed = true;
  }

  failRound(key: string, error: Error): void {
    const round = this.round(key);
    round.failure = error;
    round.completed = true;
  }

  roundCompleted(key: string): boolean {
    return this.rounds.get(key)?.completed === true;
  }

  roundFailure(key: string): Error | undefined {
    return this.rounds.get(key)?.failure;
  }

  roundHasTerminalEvent(key: string): boolean {
    return this.rounds.get(key)?.events.some(event => event.type === "done" || event.type === "error") === true;
  }

  cancel(reason?: Error): void {
    this.runtime.cancel(reason);
  }

  private scheduleCapabilityRetirement(): void {
    if (this.capabilityRetirementScheduled || !this.runtime.retireCapability) return;
    this.capabilityRetirementScheduled = true;
    // Register only after the first observer entered `runExclusive`. This ensures an immediately
    // completed mocked/real browser cannot revoke its token ahead of the browser-outcome branch.
    // At physical settlement, read the current tail so every tool-result/reconnect observer that
    // was already admitted finishes before the capability is retired.
    void this.physicalSettlement
      .then(() => this.tail)
      .then(() => this.runtime.retireCapability!())
      .catch(error => {
        console.error(
          `[chatgpt-web] failed to retire settled turn capability: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private round(key: string) {
    let round = this.rounds.get(key);
    if (round) return round;
    round = { events: [], reasoning: [], completed: false };
    this.rounds.set(key, round);
    while (this.rounds.size > 512) {
      const oldestCompleted = [...this.rounds].find(([key, candidate]) => candidate.completed
        && key !== this.continuityOrdinaryRoundKey);
      if (!oldestCompleted) {
        throw new Error("ChatGPT native round journal is full (512 unfinished rounds)");
      }
      const [oldestKey] = oldestCompleted;
      this.rounds.delete(oldestKey);
      const batch = [...this.toolBatches.values()].find(candidate => candidate.resultRoundKey === oldestKey);
      if (batch && batch.delivered.size === batch.requests.length) {
        this.toolBatches.delete(batch.id);
        for (const request of batch.requests) this.toolBatchByCallId.delete(request.callId);
      }
    }
    return round;
  }
}

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();
  private readonly conversationHeads = new Map<string, ChatGptTurnSession>();
  private readonly retirements = new Map<string, Promise<void>>();
  private readonly ownerRetirements = new Map<string, Promise<void>>();
  private readonly conversationRetirements = new Map<string, Promise<void>>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 256,
  ) {}

  getOrCreate(
    key: string,
    start: () => ChatGptTurnRuntime,
    traceId?: string,
    ownerKey?: string,
    nativeTurnId?: string,
    nativeThreadId?: string,
    instruction?: string,
  ): ChatGptTurnSession {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.supersededError) throw existing.supersededError;
      existing.touch();
      return existing;
    }
    const active = [...this.entries.values()].filter(session => session.isActive()).length;
    if (active >= MAX_CHATGPT_BROWSER_TABS) {
      throw new Error(
        `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; close or finish a browser tab before starting another`,
      );
    }
    if (this.entries.size >= this.maxEntries) throw new Error(`ChatGPT web session registry is full (${this.maxEntries} entries)`);
    const session = new ChatGptTurnSession(start(), traceId, ownerKey, nativeTurnId, nativeThreadId, instruction);
    this.entries.set(key, session);
    const conversationKey = session.conversationKey();
    if (conversationKey) this.conversationHeads.set(conversationKey, session);
    return session;
  }

  async getOrCreateAfterOwnerRetirement(
    key: string,
    ownerKey: string,
    start: () => ChatGptTurnRuntime,
    traceId?: string,
    signal?: AbortSignal,
    nativeTurnId?: string,
    nativeThreadId?: string,
    instruction?: ChatGptInstructionLineage,
  ): Promise<ChatGptTurnSession> {
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.supersededError) throw existing.supersededError;
        existing.touch();
        return existing;
      }
      const pending = this.retirements.get(key) ?? this.ownerRetirements.get(ownerKey);
      if (pending) {
        await awaitWithAbort(pending, signal);
        continue;
      }
      const activeOwner = [...this.entries].find(([ownedKey, session]) => (
        ownedKey !== key && session.ownerKey === ownerKey && !session.isPhysicallySettled()
      ));
      if (activeOwner) {
        const [ownedKey, ownedSession] = activeOwner;
        if (ownedSession.isActive() && instruction && ownedSession.instruction
          && instruction.current !== ownedSession.instruction) {
          if (!instruction.predecessors.has(ownedSession.instruction)) throw chatGptTurnSupersededError();
          // Native steering can return the old tool result and a new instruction in one request.
          // Waiting for the old browser here deadlocks before that result can be consumed. Retire
          // its capability and rebuild from the complete canonical history, including that result.
          // Keep the old entry terminal so a delayed replay cannot restart superseded work.
          const reason = chatGptTurnSupersededError();
          ownedSession.supersededError = reason;
          this.forgetConversationHead(ownedSession);
          await awaitWithAbort(this.beginRetirement(ownedKey, ownedSession, reason), signal);
          continue;
        }
        // A completed response may still be releasing its browser surface. Sequential work
        // waits for that cleanup; preemption requires a proven newer canonical instruction.
        await awaitWithAbort(ownedSession.physicalSettlement, signal);
        continue;
      }
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      return this.getOrCreate(key, start, traceId, ownerKey, nativeTurnId, nativeThreadId, instruction?.current);
    }
  }

  find(key: string): ChatGptTurnSession | undefined {
    const session = this.entries.get(key);
    session?.touch();
    return session;
  }

  /** Drop only a proved pre-mutation first-creation failure. The durable creation claim remains live. */
  discardRetryableContinuityCreation(
    key: string,
    session: ChatGptTurnSession,
    binding: ContinuityBinding,
  ): boolean {
    if (this.entries.get(key) !== session || session.runtime.continuityBinding !== binding
      || binding.state !== "creating" || binding.initialExecutionKey !== key
      || binding.executionKey !== key || binding.lease || session.runtime.submission?.phase !== "prepared"
      || session.settledOutcome()?.type !== "error") return false;
    this.entries.delete(key);
    this.forgetConversationHead(session);
    return true;
  }

  findConversationHead(conversationKey: string): ChatGptTurnSession | undefined {
    const session = this.conversationHeads.get(conversationKey);
    session?.touch();
    return session;
  }

  /** Continuity cannot adopt an in-flight owner from another route/provider namespace. */
  assertContinuityThreadAvailable(nativeThreadId: string, executionKey: string): void {
    this.prune();
    for (const [key, session] of this.entries) {
      if (key !== executionKey && session.nativeThreadId === nativeThreadId
        && (!session.isPhysicallySettled() || session.outstanding().length > 0)) {
        throw continuityError("continuity_source_unproven", "Finish or explicitly cancel the existing native-thread owner before changing modes.");
      }
    }
    if (!this.entries.has(executionKey)) {
      if ([...this.entries.values()].filter(session => session.isActive()).length >= MAX_CHATGPT_BROWSER_TABS) {
        throw continuityError("continuity_resource_capacity", "Finish or close an existing browser turn before starting another.");
      }
      while (this.entries.size >= this.maxEntries) {
        const historical = [...this.entries].filter(([key, session]) => session.runtime.continuityBinding
          && !session.isActive() && session.isPhysicallySettled() && session.outstanding().length === 0
          && !this.protectedContinuityBinding(key, session))
          .sort(([, left], [, right]) => left.lastUsedAt() - right.lastUsedAt());
        if (historical.length === 0) throw continuityError("continuity_resource_capacity");
        let reclaimed = false;
        let blockedByReplayCapacity: ChatGptWebAdapterError | undefined;
        for (const [historicalKey, historicalSession] of historical) {
          try {
            this.retainContinuityReplayIdentity(historicalKey, historicalSession);
          } catch (error) {
            if (error instanceof ChatGptWebAdapterError && error.code === "continuity_resource_capacity") {
              blockedByReplayCapacity ??= error;
              continue;
            }
            throw error;
          }
          // This is replay-cache reclamation, not task cancellation. Its former physical page
          // may already belong to another execution or to a committed checkpoint.
          this.entries.delete(historicalKey);
          this.forgetConversationHead(historicalSession);
          reclaimed = true;
          break;
        }
        if (!reclaimed) throw blockedByReplayCapacity ?? continuityError("continuity_resource_capacity");
      }
    }
  }

  assertUnconsumedContinuityInstruction(
    binding: ContinuityBinding,
    parsed: CodexParsedRequest,
  ): void {
    const identity = extractChatGptTurnIdentity(parsed);
    if (!identity.turnId) return;
    const instructionIdentity = continuityInstructionIdentity(parsed);
    for (const session of this.entries.values()) {
      if (session.runtime.continuityBinding !== binding
        || session.runtime.usageInput?._compactionRequest === true
        || !session.nativeTurnId) continue;
      if (session.acceptedContinuityInstructionIdentity() === instructionIdentity) {
        throw continuityError(
          "continuity_source_unproven",
          "The current native instruction was already consumed by a completed native turn.",
        );
      }
    }
    for (const tombstone of binding.ordinaryReplayTombstones.values()) {
      if (!tombstone.nativeTurnId) continue;
      if (tombstone.instructionIdentity === instructionIdentity) {
        throw continuityError(
          "continuity_source_unproven",
          "The current native instruction was already consumed by a completed native turn.",
        );
      }
    }
  }

  /** Selecting a different route cannot take over work that still has a live writer. */
  assertContinuityCanLeave(binding: ContinuityBinding): void {
    if (["running", "compacting"].includes(binding.state)
      || [...this.entries.values()].some(session => session.runtime.continuityBinding === binding
        && (session.isActive() || !session.isPhysicallySettled() || session.outstanding().length > 0))) {
      throw continuityError("continuity_source_unproven", "Finish or explicitly cancel the current continuity work before selecting another route.");
    }
  }

  /** Mode exit removes write ownership but preserves accepted ordinary answers and journals. */
  async detachContinuityBinding(binding: ContinuityBinding): Promise<void> {
    this.assertContinuityCanLeave(binding);
    const sessions = [...this.entries.values()].filter(session => session.runtime.continuityBinding === binding);
    for (const session of sessions) {
      this.forgetConversationHead(session);
      const key = session.conversationKey();
      if (key) session.detachConversation(key);
    }
    await Promise.all(sessions.map(session => session.runtime.retireCapability?.()));
  }

  /** Wait for a retained conversation epoch that has been detached but not physically released. */
  async waitForConversationRetirement(conversationKey: string, signal?: AbortSignal): Promise<void> {
    const pending = this.conversationRetirements.get(conversationKey);
    if (pending) await awaitWithAbort(pending, signal);
  }

  async retireConversationAndWait(conversationKey: string): Promise<number> {
    return this.closeConversationAndWait(conversationKey);
  }

  /** Retire only the settled execution after a same-page handoff. Never release its surface. */
  async retireContinuityExecution(
    executionKey: string,
    source: ChatGptTurnSession,
    conversationKey: string,
    preserveFinalResponse: boolean,
  ): Promise<void> {
    if (this.entries.get(executionKey) !== source || this.conversationHeads.get(conversationKey) !== source
      || source.conversationKey() !== conversationKey || !source.isPhysicallySettled()
      || source.settledOutcome()?.type !== "final" || source.outstanding().length > 0) {
      throw continuityError("continuity_source_unproven");
    }
    await source.runtime.retireCapability?.();
    if (this.entries.get(executionKey) !== source || this.conversationHeads.get(conversationKey) !== source) {
      throw continuityError("continuity_source_unproven");
    }
    this.forgetConversationHead(source);
    source.detachConversation(conversationKey);
    if (!preserveFinalResponse) source.supersededError = continuityError("continuity_source_unproven", "This execution ended at a checkpoint; its summary is not an ordinary answer.");
  }

  /**
   * Close the physical retained-chat epoch without discarding a terminal response that won the
   * compaction race before any compaction instruction reached that response. The detached logical
   * session remains addressable by its exact Responses execution key, so the post-compaction
   * native round can consume the already-committed answer instead of opening another browser turn.
   */
  async retireConversationPreservingFinalResponse(
    conversationKey: string,
    preserved: ChatGptTurnSession,
    preservedExecutionKey: string,
  ): Promise<number> {
    if (!preservedExecutionKey) throw new Error("Preserved ChatGPT response execution key is required");
    const outcome = preserved.settledOutcome();
    if (!outcome || outcome.type !== "final") {
      throw new Error("Only a settled final ChatGPT response can survive retained-conversation retirement");
    }
    return this.closeConversationAndWait(conversationKey, {
      session: preserved,
      executionKey: preservedExecutionKey,
    });
  }

  private async closeConversationAndWait(
    conversationKey: string,
    preserved?: { session: ChatGptTurnSession; executionKey: string },
  ): Promise<number> {
    const pending = this.conversationRetirements.get(conversationKey);
    if (pending) {
      await pending;
      return 0;
    }
    const matches = [...this.entries].filter(([, session]) => (
      session.conversationKey() === conversationKey
    ));
    if (matches.length === 0) return 0;
    if (preserved && !matches.some(([, session]) => session === preserved.session)) {
      throw new Error("The final ChatGPT response does not own the retained conversation being retired");
    }
    const target = preserved ? this.entries.get(preserved.executionKey) : undefined;
    if (target && target !== preserved?.session) {
      throw new Error("The compacted ChatGPT response execution key is already owned by another session");
    }
    this.conversationHeads.delete(conversationKey);
    for (const [key, session] of matches) {
      if (this.entries.get(key) === session
        && (session !== preserved?.session || key !== preserved.executionKey)) {
        this.entries.delete(key);
      }
      if (session.isActive()) session.cancel();
      if (!session.detachConversation(conversationKey)) {
        throw new Error("ChatGPT retained-conversation ownership changed during retirement");
      }
    }
    if (preserved) this.entries.set(preserved.executionKey, preserved.session);
    const release = matches.findLast(([, session]) => (
      session.runtime.releaseRetainedConversation !== undefined
    ))?.[1].runtime.releaseRetainedConversation;
    const retirement = Promise.all(matches.map(([, session]) => session.physicalSettlement))
      .then(async () => { await release?.(); });
    this.conversationRetirements.set(conversationKey, retirement);
    try {
      await retirement;
    } finally {
      if (this.conversationRetirements.get(conversationKey) === retirement) {
        this.conversationRetirements.delete(conversationKey);
      }
    }
    return matches.length;
  }

  async waitForRetirement(key: string): Promise<void> {
    await this.retirements.get(key);
  }

  async retireAndWait(key: string, signal?: AbortSignal): Promise<boolean> {
    const pending = this.retirements.get(key);
    if (pending) {
      await awaitWithAbort(pending, signal);
      return true;
    }
    const session = this.entries.get(key);
    if (!session) return false;

    this.entries.delete(key);
    this.forgetConversationHead(session);
    await awaitWithAbort(this.beginRetirement(key, session), signal);
    return true;
  }

  retire(key: string, session: ChatGptTurnSession): boolean {
    if (this.entries.get(key) !== session) return false;
    this.entries.delete(key);
    this.forgetConversationHead(session);
    this.beginRetirement(key, session);
    return true;
  }

  /** Cancel only active responses whose exact native turn ids Codex marked as interrupted. */
  retireAbortedOwnerTurns(
    ownerKey: string,
    abortedTurnIds: ReadonlySet<string>,
    keepKey: string,
  ): number {
    const matches = [...this.entries].filter(([key, session]) => (
      key !== keepKey
      && session.ownerKey === ownerKey
      && session.nativeTurnId !== undefined
      && abortedTurnIds.has(session.nativeTurnId)
      && session.isActive()
    ));
    for (const [key, session] of matches) {
      this.entries.delete(key);
      this.forgetConversationHead(session);
      this.beginRetirement(key, session);
    }
    return matches.length;
  }

  clear(): number {
    const cancelled = this.entries.size;
    for (const [key, session] of this.entries) this.beginRetirement(key, session);
    this.entries.clear();
    this.conversationHeads.clear();
    return cancelled;
  }

  async cancelTrace(traceId: string, reason = chatGptBrowserTabClosedError()): Promise<number> {
    const cancellation = this.beginCancelTrace(traceId, reason);
    await cancellation.settlement;
    return cancellation.cancelled;
  }

  /** Revoke execution immediately; keep physical cleanup tracked independently of the UI receipt. */
  beginCancelTrace(traceId: string, reason: Error): { cancelled: number; settlement: Promise<void> } {
    const sessions = [...this.entries.values()]
      .filter(session => session.traceId === traceId && session.isActive());
    for (const session of sessions) session.cancel(reason);
    return { cancelled: sessions.length, settlement: Promise.all(sessions.map(session => session.physicalSettlement)).then(() => undefined) };
  }

  /**
   * Begin retiring only the browser execution owned by the exact native Codex turn.
   *
   * Codex runs Interrupt hooks synchronously with a short deadline. Ownership is removed and the
   * abort is delivered before this method returns; physical helper cleanup remains represented by
   * `settlement`, so replacement turns still serialize behind the real teardown without blocking
   * the hook acknowledgement itself.
   */
  cancelNativeTurn(
    threadId: string,
    turnId: string,
    reason: Error,
  ): { cancelled: number; settlement: Promise<void> } {
    const matches = [...this.entries].filter(([, session]) => (
      session.nativeThreadId === threadId
      && session.nativeTurnId === turnId
    ));
    for (const [key, session] of matches) {
      if (this.entries.get(key) !== session) continue;
      this.entries.delete(key);
      this.forgetConversationHead(session);
    }
    const settlement = Promise.all(
      matches.map(([key, session]) => this.beginRetirement(key, session, reason)),
    ).then(() => undefined);
    return { cancelled: matches.length, settlement };
  }

  cancelledError(traceId: string): Error | undefined {
    for (const session of this.entries.values()) {
      if (session.traceId !== traceId) continue;
      if (session.supersededError) return session.supersededError;
      const outcome = session.settledOutcome();
      if (outcome?.type !== "error") continue;
      if ("code" in outcome.error && outcome.error.code === "client_cancelled") return outcome.error;
    }
    return undefined;
  }

  activeCount(): number {
    this.prune();
    let active = 0;
    for (const session of this.entries.values()) if (session.isActive()) active += 1;
    return active;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, session] of this.entries) {
      const binding = this.protectedContinuityBinding(key, session);
      if (session.isActive() || (session.runtime.continuityBinding
        && (!session.isPhysicallySettled() || session.outstanding().length > 0))) continue;
      if (binding && binding.state !== "ready") continue;
      const idleSince = binding?.lastUsedAt ?? session.lastUsedAt();
      const ttl = binding ? CONTINUITY_IDLE_TTL_MS : this.ttlMs;
      if (binding ? now - idleSince < ttl : now - idleSince <= ttl) continue;
      if (!session.runtime.continuityBinding || binding) session.cancel();
      if (!binding) {
        try {
          this.retainContinuityReplayIdentity(key, session);
        } catch (error) {
          if (error instanceof ChatGptWebAdapterError && error.code === "continuity_resource_capacity") continue;
          throw error;
        }
      }
      this.entries.delete(key);
      this.forgetConversationHead(session);
    }
  }

  private retainContinuityReplayIdentity(key: string, session: ChatGptTurnSession): void {
    const binding = session.runtime.continuityBinding;
    const input = session.runtime.usageInput;
    if (!binding || input?._compactionRequest === true || binding.state === "lost" || binding.state === "ended") return;
    retainContinuityOrdinaryReplayTombstone(
      binding,
      key,
      input?._continuityHistoryRevision as number,
      session.acceptedContinuityInstructionIdentity(),
      session.nativeTurnId,
    );
  }

  private protectedContinuityBinding(key: string, session: ChatGptTurnSession): ContinuityBinding | undefined {
    const binding = session.runtime.continuityBinding;
    if (!binding || binding.state === "lost" || binding.state === "ended") return undefined;
    const conversationKey = session.conversationKey();
    if (conversationKey && this.conversationHeads.get(conversationKey) === session) return binding;
    if (binding.executionKey === undefined && [...binding.checkpoints.values()].some(checkpoint => (
      checkpoint.revision === binding.revision && checkpoint.preserveFinalResponse
      && checkpoint.sourceExecutionKey === key
    ))) return binding;
    return undefined;
  }

  private forgetConversationHead(session: ChatGptTurnSession): void {
    const conversationKey = session.conversationKey();
    if (conversationKey && this.conversationHeads.get(conversationKey) === session) {
      this.conversationHeads.delete(conversationKey);
    }
  }

  private beginRetirement(key: string, session: ChatGptTurnSession, reason?: Error): Promise<void> {
    const existing = this.retirements.get(key);
    if (existing) return existing;
    const conversationKey = session.conversationKey();
    session.cancel(reason);
    const retirement = session.physicalSettlement;
    this.retirements.set(key, retirement);
    void retirement.then(() => {
      if (this.retirements.get(key) === retirement) this.retirements.delete(key);
    });
    if (session.ownerKey) {
      const previous = this.ownerRetirements.get(session.ownerKey);
      const ownerRetirement = previous
        ? Promise.all([previous, retirement]).then(() => undefined)
        : retirement;
      this.ownerRetirements.set(session.ownerKey, ownerRetirement);
      void ownerRetirement.then(() => {
        if (this.ownerRetirements.get(session.ownerKey!) === ownerRetirement) {
          this.ownerRetirements.delete(session.ownerKey!);
        }
      });
    }
    if (conversationKey) {
      const previous = this.conversationRetirements.get(conversationKey);
      const conversationRetirement = previous
        ? Promise.all([previous, retirement]).then(() => undefined)
        : retirement;
      this.conversationRetirements.set(conversationKey, conversationRetirement);
      const forgetConversationRetirement = () => {
        if (this.conversationRetirements.get(conversationKey) === conversationRetirement) {
          this.conversationRetirements.delete(conversationKey);
        }
      };
      void conversationRetirement.then(
        forgetConversationRetirement,
        forgetConversationRetirement,
      );
    }
    return retirement;
  }
}

export const chatGptTurnSessions = new ChatGptTurnSessions();
