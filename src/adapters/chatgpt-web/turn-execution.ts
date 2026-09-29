import { createHash } from "node:crypto";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "../../types";
import { canonicalJson } from "./canonical-json";
import type { BrokerToolRequest } from "./turn-broker";
import { ChatGptWebAdapterError, chatGptBrowserTabClosedError, chatGptTurnSupersededError } from "./adapter-error";
import {
  chatGptTurnUserRevisionHistory,
  extractChatGptCompactionSourceRevision,
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
} from "./environment";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import { continuityError } from "./continuity-errors";
import { retainContinuityOrdinaryReplayTombstone, type ContinuityBinding } from "./continuity-binding";
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

function canonicalInputDigest(input: unknown[]): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function rawRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function activeToolCallMatches(item: Record<string, unknown>, request: BrokerToolRequest): boolean {
  if (item.call_id !== request.callId) return false;
  if (item.type === "tool_search_call") {
    if (request.freeform || request.wireName !== "tool_search") return false;
    return canonicalJson(item.arguments ?? {}) === canonicalJson(request.arguments ?? {});
  }
  const name = typeof item.name === "string" ? item.name : undefined;
  const namespace = typeof item.namespace === "string" ? item.namespace : undefined;
  if (!name || namespacedToolName(namespace, name) !== request.wireName) return false;
  if (request.freeform) {
    return item.type === "custom_tool_call" && (item.input ?? "") === (request.input ?? "");
  }
  if (item.type !== "function_call") return false;
  let args: unknown = item.arguments ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); }
    catch { return false; }
  }
  return canonicalJson(args) === canonicalJson(request.arguments ?? {});
}

function activeToolResultMatches(item: Record<string, unknown>, request: BrokerToolRequest): boolean {
  if (item.call_id !== request.callId) return false;
  if (request.wireName === "tool_search") return item.type === "tool_search_output";
  return item.type === (request.freeform ? "custom_tool_call_output" : "function_call_output");
}

function responseOutputDigest(output: unknown[]): string {
  return canonicalInputDigest(output.map(value => {
    const item = rawRecord(value);
    if (!item || !("id" in item)) return value;
    const { id: _id, ...owned } = item;
    return owned;
  }));
}

export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
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
  private readonly deliveredResultIds = new Set<string>();
  private outstandingReasoning: string[] = [];
  private finalReasoning: string[] = [];
  private outstandingPrelude: AdapterEvent[] = [];
  private finalPrelude: AdapterEvent[] = [];
  private settledBrowserOutcome?: ChatGptBrowserOutcome;
  private settledPhysical = false;
  private attachedConversationKey: string | undefined;
  private canonicalInputValue?: unknown[];
  private readonly canonicalInputDigests = new Set<string>();
  private readonly canonicalInputGenerationByDigest = new Map<string, number>();
  private canonicalInputGeneration = 0;
  private readonly responseOutputByGeneration = new Map<number, { length: number; digest: string }>();
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

  acceptCanonicalInput(parsed: CodexParsedRequest): void {
    const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
    if (!Array.isArray(input)) throw continuityError("continuity_source_unproven");
    if (!this.canonicalInputValue) {
      this.canonicalInputValue = structuredClone(input);
      const digest = canonicalInputDigest(input);
      this.canonicalInputDigests.add(digest);
      this.canonicalInputGeneration += 1;
      this.canonicalInputGenerationByDigest.set(digest, this.canonicalInputGeneration);
      return;
    }
    const digest = canonicalInputDigest(input);
    if (this.runtime.continuityBinding?.state === "compacting"
      && digest !== canonicalInputDigest(this.canonicalInputValue)) {
      throw continuityError("continuity_source_unproven", "Compaction owns the canonical input boundary.");
    }
    if (this.canonicalInputDigests.has(digest)) return;
    this.assertCanonicalExtension(input);
    this.canonicalInputValue = structuredClone(input);
    this.canonicalInputDigests.add(digest);
    this.canonicalInputGeneration += 1;
    this.canonicalInputGenerationByDigest.set(digest, this.canonicalInputGeneration);
  }

  assertCanonicalReplayInput(parsed: CodexParsedRequest): void {
    const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
    if (!Array.isArray(input) || !this.canonicalInputValue) throw continuityError("continuity_source_unproven");
    if (this.canonicalInputDigests.has(canonicalInputDigest(input))) return;
    this.assertCanonicalExtension(input);
  }

  assertCompactionSourceHistory(input: unknown[], expectedGeneration?: number): number {
    if (!this.canonicalInputValue) throw continuityError("continuity_source_unproven");
    if (expectedGeneration !== undefined && expectedGeneration !== this.canonicalInputGeneration) {
      throw continuityError("continuity_source_unproven", "The compaction source history changed after preflight.");
    }
    if (canonicalInputDigest(input) !== canonicalInputDigest(this.canonicalInputValue)) {
      this.assertCanonicalExtension(input);
    }
    return this.canonicalInputGeneration;
  }

  canonicalInputGenerationFor(input: unknown[]): number | undefined {
    return this.canonicalInputGenerationByDigest.get(canonicalInputDigest(input));
  }

  recordResponseOutput(output: unknown[], generation = this.canonicalInputGeneration): void {
    const proof = { length: output.length, digest: responseOutputDigest(output) };
    const existing = this.responseOutputByGeneration.get(generation);
    if (existing && (existing.length !== proof.length || existing.digest !== proof.digest)) {
      throw continuityError("continuity_source_unproven", "A replay changed the owned response output.");
    }
    this.responseOutputByGeneration.set(generation, proof);
  }

  recordedResponseOutputLength(input: unknown[], offset: number, required = true): number | undefined {
    const proof = this.responseOutputByGeneration.get(this.canonicalInputGeneration);
    if (!proof) return undefined;
    const output = input.slice(offset, offset + proof.length);
    if (output.length !== proof.length || responseOutputDigest(output) !== proof.digest) {
      if (!required) return undefined;
      throw continuityError("continuity_source_unproven", "The retained history does not contain the exact owned response output.");
    }
    return proof.length;
  }

  canonicalInput(): unknown[] | undefined {
    return this.canonicalInputValue ? structuredClone(this.canonicalInputValue) : undefined;
  }

  private assertCanonicalExtension(input: unknown[]): void {
    const canonical = this.canonicalInputValue;
    if (!canonical) {
      throw continuityError("continuity_source_unproven", "A replay cannot replace the owned canonical input.");
    }
    const outstanding = this.outstanding();
    if (!canonical.every((item, index) => canonicalInputDigest([item]) === canonicalInputDigest([input[index]]))) {
      throw continuityError("continuity_source_unproven", "The active input is not owned by the current execution.");
    }
    const recordedOutputLength = this.recordedResponseOutputLength(input, canonical.length);
    if (recordedOutputLength !== undefined) {
      const resultsInput = input.slice(canonical.length + recordedOutputLength);
      if (!this.isActive()) {
        if (outstanding.length > 0 || resultsInput.length > 0) {
          throw continuityError("continuity_source_unproven", "The settled response history contains an unowned execution record.");
        }
        return;
      }
      if (resultsInput.length !== outstanding.length) {
        throw continuityError("continuity_source_unproven", "The active input is incomplete for the current execution.");
      }
      const expected = new Map(outstanding.map(request => [request.callId, request]));
      const results = new Set<string>();
      for (const value of resultsInput) {
        const item = rawRecord(value);
        const callId = typeof item?.call_id === "string" ? item.call_id : undefined;
        const request = callId ? expected.get(callId) : undefined;
        if (!item || !callId || !request || !activeToolResultMatches(item, request) || results.has(callId)) {
          throw continuityError("continuity_source_unproven", "The active input contains an unowned execution record.");
        }
        results.add(callId);
      }
      if (results.size !== outstanding.length) {
        throw continuityError("continuity_source_unproven", "The active input is incomplete for the current execution.");
      }
      return;
    }
    if (!this.isActive() || input.length !== canonical.length + outstanding.length * 2) {
      throw continuityError("continuity_source_unproven", "A replay cannot replace the owned canonical input.");
    }
    const expected = new Map(outstanding.map(request => [request.callId, request]));
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const value of input.slice(canonical.length)) {
      const item = rawRecord(value);
      const callId = typeof item?.call_id === "string" ? item.call_id : undefined;
      const request = callId ? expected.get(callId) : undefined;
      if (!item || !callId || !request) {
        throw continuityError("continuity_source_unproven", "The active input contains an unowned execution record.");
      }
      if (activeToolCallMatches(item, request)) {
        if (calls.has(callId)) throw continuityError("continuity_source_unproven");
        calls.add(callId);
        continue;
      }
      if (activeToolResultMatches(item, request)) {
        if (results.has(callId)) throw continuityError("continuity_source_unproven");
        results.add(callId);
        continue;
      }
      throw continuityError("continuity_source_unproven", "The active input contains an unowned execution record.");
    }
    if (calls.size !== outstanding.length || results.size !== outstanding.length) {
      throw continuityError("continuity_source_unproven", "The active input is incomplete for the current execution.");
    }
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
    for (const request of requests) {
      if (this.deliveredResultIds.has(request.callId) || this.outstandingById.has(request.callId)) {
        throw new Error(`duplicate ChatGPT bridge tool call id: ${request.callId}`);
      }
      this.outstandingById.set(request.callId, request);
    }
    this.outstandingReasoning = [...reasoning];
    this.outstandingPrelude = [...prelude];
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string): void {
    if (!this.outstandingById.delete(callId)) throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    this.deliveredResultIds.add(callId);
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
      const oldestCompleted = [...this.rounds].find(([, candidate]) => candidate.completed);
      if (!oldestCompleted) {
        throw new Error("ChatGPT native round journal is full (512 unfinished rounds)");
      }
      this.rounds.delete(oldestCompleted[0]);
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

  recordResponseOutput(nativeThreadId: string, nativeTurnId: string, input: unknown[], output: unknown[]): void {
    const matches = [...this.entries.values()].flatMap(session => {
      if (session.nativeThreadId !== nativeThreadId || session.nativeTurnId !== nativeTurnId) return [];
      const generation = session.canonicalInputGenerationFor(input);
      return generation === undefined ? [] : [{ session, generation }];
    });
    if (matches.length !== 1) {
      throw continuityError("continuity_source_unproven", "The completed response no longer has one exact execution owner.");
    }
    matches[0]!.session.recordResponseOutput(output, matches[0]!.generation);
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
    retainContinuityOrdinaryReplayTombstone(binding, key, input?._continuityHistoryRevision as number);
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
