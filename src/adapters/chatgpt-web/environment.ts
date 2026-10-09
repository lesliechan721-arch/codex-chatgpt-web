import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildCompactV1Output, decodeCompactionSummary, extractCompactUserMessages, isReadableCompactionSummaryText, OPAQUE_COMPACTION_NOTE } from "../../responses/compaction";
import type { CodexContentPart, CodexParsedRequest, CodexTool } from "../../types";
import { isAcceptedCompactionContinuation, recoverCompactionInstruction } from "./compaction-continuation";
import { ChatGptWebAdapterError } from "./adapter-error";
import { continuityError } from "./continuity-errors";
import { canonicalJson } from "./canonical-json";

export type ChatGptSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean };

export interface ChatGptTurnEnvironment {
  cwd: string;
  roots: string[];
  writableRoots: string[];
  sandboxPolicy: ChatGptSandboxPolicy;
  tools: CodexTool[];
}

export interface ChatGptDelegatedTurnCapability {
  authorityMode: "delegated";
  threadId: string;
  turnId: string;
  tools: CodexTool[];
}

export type ChatGptTurnCapability = ChatGptTurnEnvironment | ChatGptDelegatedTurnCapability;

export interface ChatGptTurnIdentity {
  threadId?: string;
  turnId?: string;
  parentThreadId?: string;
  agentName?: string;
  subagentKind?: string;
  promptCacheKey?: string;
}

export interface ChatGptThreadSpawnLineage {
  threadId: string;
  parentThreadId: string;
  agentName: string;
  sandboxType: ChatGptSandboxPolicy["type"];
  workspaceRoots: string[];
}

export interface ChatGptRootThreadMetadata {
  threadId: string;
  sandboxType: ChatGptSandboxPolicy["type"] | "platform";
  workspaceRoots: string[];
}

export interface ChatGptTurnUserRevision {
  content: unknown;
  turnId?: string;
  itemId?: string;
  instructionEnvelope?: Record<string, unknown>;
}

export const CHATGPT_TURN_REVISION_CONFLICT_MESSAGE =
  "ChatGPT web current user message conflicts with native Codex turn_id metadata";

export class TrustedCodexEnvironmentValidationError extends ChatGptWebAdapterError {
  constructor(message: string, code = "invalid_trusted_codex_environment") {
    super(message, {
      status: 400,
      errorType: "invalid_request_error",
      code,
      retryable: false,
    });
    this.name = "TrustedCodexEnvironmentValidationError";
  }
}

export class MissingTrustedCodexEnvironmentError extends TrustedCodexEnvironmentValidationError {
  constructor(field: string) {
    super(
      `ChatGPT web turn is missing ${field} in trusted Codex environment context`,
      "missing_trusted_codex_environment",
    );
    this.name = "MissingTrustedCodexEnvironmentError";
  }
}

function contentText(content: string | CodexContentPart[]): string {
  if (typeof content === "string") return content;
  return content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function inputItemType(item: Record<string, unknown> | undefined): unknown {
  return item?.type ?? (typeof item?.role === "string" ? "message" : undefined);
}

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function clientTurnMetadataFromBody(value: unknown): Record<string, unknown> | undefined {
  const body = record(value);
  const metadata = record(body?.client_metadata);
  const raw = metadata?.["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    try { return record(JSON.parse(raw)); }
    catch { return undefined; }
  }
  return record(raw);
}

export function isCodexThreadTitleRequestFromBody(value: unknown): boolean {
  const metadata = clientTurnMetadataFromBody(value);
  if (metadata?.request_kind !== "turn") return false;
  if (metadata.thread_source === "thread_title") return true;
  if (metadata.thread_source !== "system") return false;

  const body = record(value);
  const text = record(body?.text);
  const format = record(text?.format);
  const schema = record(format?.schema);
  const properties = record(schema?.properties);
  const title = record(properties?.title);
  const required = schema?.required;
  return format?.type === "json_schema"
    && schema?.type === "object"
    && schema?.additionalProperties === false
    && properties !== undefined
    && Object.keys(properties).length === 1
    && title?.type === "string"
    && title.minLength === 1
    && title.maxLength === 36
    && Array.isArray(required)
    && required.length === 1
    && required[0] === "title";
}

export function isCodexGuardianReviewRequestFromBody(value: unknown): boolean {
  const metadata = clientTurnMetadataFromBody(value);
  return metadata?.request_kind === "turn"
    && (metadata.thread_source === "guardian_review" || metadata.turn_trigger === "guardian_review");
}

/** Codex recaps share the generic system source; match their bounded output contract too. */
export function isCodexRecapRequestFromBody(value: unknown): boolean {
  const metadata = clientTurnMetadataFromBody(value);
  if (metadata?.request_kind !== "turn" || metadata.thread_source !== "system") return false;

  const format = record(record(record(value)?.text)?.format);
  const schema = record(format?.schema);
  const properties = record(schema?.properties);
  const summary = record(properties?.summary);
  const nextAction = record(properties?.next_action);
  const required = schema?.required;
  const nextActionTypes = nextAction?.type;
  return format?.type === "json_schema"
    && format.strict === true
    && schema?.type === "object"
    && schema.additionalProperties === false
    && properties !== undefined
    && Object.keys(properties).length === 2
    && summary?.type === "string"
    && summary.minLength === 1
    && summary.maxLength === 700
    && Array.isArray(nextActionTypes)
    && nextActionTypes.length === 2
    && nextActionTypes.includes("string")
    && nextActionTypes.includes("null")
    && nextAction?.maxLength === 200
    && Array.isArray(required)
    && required.length === 2
    && required.includes("summary")
    && required.includes("next_action");
}

function clientTurnMetadata(parsed: CodexParsedRequest): Record<string, unknown> | undefined {
  return clientTurnMetadataFromBody(parsed._rawBody);
}

function itemTurnId(value: unknown): string | undefined {
  const turnId = record(record(value)?.internal_chat_message_metadata_passthrough)?.turn_id;
  return typeof turnId === "string" ? turnId : undefined;
}

function rawMessageText(value: Record<string, unknown>): string {
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content
    .map(part => record(part)?.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/** Native context is a user fragment, never an XML mention in an answer, tool result or request. */
function hasEnvironmentContextFragment(item: Record<string, unknown> | undefined): item is Record<string, unknown> {
  if (inputItemType(item) !== "message" || item?.role !== "user") return false;
  const kinds = record(item.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  // Keep explicitly typed native fragments fail-closed even when their XML is malformed.
  if (Array.isArray(kinds) && kinds.includes("environments.environment_context")) return true;
  const texts = typeof item.content === "string" ? [item.content]
    : Array.isArray(item.content) ? item.content.map(part => record(part)?.text) : [];
  // Older wire messages have no content kind. A fragment starting an environment tag is
  // still an attempted update when truncated; prose mentions and fenced examples are not.
  return texts.some(text => typeof text === "string"
    && /^<\/?environment_context\b/i.test(text.trimStart()));
}

function rawMessageHasEnvironmentContext(value: Record<string, unknown>): boolean {
  return hasEnvironmentContextFragment(value);
}

function messageContentKinds(value: Record<string, unknown>): string[] | undefined {
  const kinds = record(value.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  return Array.isArray(kinds) && kinds.every(kind => typeof kind === "string")
    ? kinds as string[]
    : undefined;
}

interface CurrentChatGptEnvironmentPart {
  item: Record<string, unknown>;
  text: string;
  kind?: string;
}

function rawMessageEnvironmentParts(item: Record<string, unknown>): CurrentChatGptEnvironmentPart[] {
  if (!hasEnvironmentContextFragment(item)) return [];
  const kinds = messageContentKinds(item);
  if (typeof item.content === "string") {
    const kind = kinds?.length === 1 ? kinds[0] : undefined;
    return kind === "environments.environment_context" || /^<\/?environment_context\b/i.test(item.content.trimStart())
      ? [{ item, text: item.content, ...(kinds?.length === 1 ? { kind: kinds[0] } : {}) }]
      : [];
  }
  if (!Array.isArray(item.content)) return [];
  return item.content.flatMap((value, index) => {
    const text = record(value)?.text;
    const kind = kinds?.[index];
    if (typeof text !== "string"
      || (kind !== "environments.environment_context" && !/^<\/?environment_context\b/i.test(text.trimStart()))) return [];
    return [{ item, text, ...(typeof kinds?.[index] === "string" ? { kind: kinds[index] } : {}) }];
  });
}

function currentChatGptEnvironmentParts(parsed: CodexParsedRequest): CurrentChatGptEnvironmentPart[] {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  if (!turnId) {
    return input.flatMap(value => {
      const item = record(value);
      return inputItemType(item) === "message" && item ? rawMessageEnvironmentParts(item) : [];
    });
  }
  const parts: CurrentChatGptEnvironmentPart[] = [];
  let laterAssistantOutput = false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (!item) continue;
    const type = inputItemType(item);
    if ((type === "message" && item.role === "assistant")
      || item.type === "function_call" || item.type === "reasoning" || item.type === "compaction") {
      laterAssistantOutput = true;
    }
    if (type !== "message") continue;
    const owner = itemTurnId(item);
    if (owner === turnId || (owner === undefined && !laterAssistantOutput)) {
      parts.push(...rawMessageEnvironmentParts(item));
    }
  }
  return parts;
}

/** True when the raw Responses input attempted to carry an environment envelope, valid or not. */
export function hasRawChatGptEnvironmentContext(parsed: CodexParsedRequest): boolean {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.some(value => hasEnvironmentContextFragment(record(value)));
}

/** Historical XML is not a current environment update, including in old untagged rollouts. */
export function hasCurrentChatGptEnvironmentContext(parsed: CodexParsedRequest): boolean {
  return currentChatGptEnvironmentParts(parsed).length > 0;
}

function isCanonicalRolloutEnvironmentMarker(text: string): boolean {
  const match = /^<environment_context>([\s\S]*)<\/environment_context>$/.exec(text.trim());
  if (!match) return false;
  const body = match[1]!;
  const tag = /<(shell|current_date|timezone)>([^<]+)<\/\1>/g;
  const seen = new Set<string>();
  let cursor = 0;
  for (const current of body.matchAll(tag)) {
    if (body.slice(cursor, current.index).trim() || seen.has(current[1]!)) return false;
    seen.add(current[1]!);
    cursor = current.index! + current[0].length;
  }
  return seen.size > 0 && !body.slice(cursor).trim();
}

/**
 * Paginated Codex turns can synthesize a current environment envelope that carries lifecycle
 * provenance but omits filesystem authority. That marker must never create authority itself; it
 * may only allow the caller to recover the same turn from Codex's native rollout.
 */
export function hasCurrentChatGptRolloutEnvironmentMarker(parsed: CodexParsedRequest): boolean {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!turnId) return false;
  const parts = currentChatGptEnvironmentParts(parsed);
  if (parts.length !== 1) return false;
  const marker = parts[0]!;
  return marker.item.role === "user"
    && typeof marker.item.id === "string" && marker.item.id.length > 0
    && itemTurnId(marker.item) === turnId
    && marker.kind === "environments.environment_context"
    && isCanonicalRolloutEnvironmentMarker(marker.text);
}

function countPattern(text: string, pattern: RegExp): number {
  let count = 0;
  for (const _match of text.matchAll(pattern)) count += 1;
  return count;
}

/** Stable retry correlation from bounded request structure only; message content is never hashed. */
export function trustedEnvironmentRequestFingerprint(parsed: CodexParsedRequest): string {
  const hash = createHash("sha256");
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const identity = extractChatGptTurnIdentity(parsed);
  const update = (value: unknown): void => {
    const text = typeof value === "string" ? value : value === undefined ? "" : String(value);
    hash.update(String(text.length)).update(":").update(text).update("|");
  };
  update(parsed.modelId);
  update(identity.threadId);
  update(identity.turnId);
  update(parsed.previousResponseId);
  update(parsed._replayPrefixLen ?? 0);
  update(input.length);
  for (const value of input) {
    const item = record(value);
    update(inputItemType(item));
    update(item?.role);
    update(item?.id);
    update(itemTurnId(item));
  }
  return hash.digest("hex").slice(0, 12);
}

/** Structural evidence only, never filesystem authority or raw user/environment content. */
export function trustedEnvironmentRequestDetails(parsed: CodexParsedRequest): Record<string, string | boolean | number> {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  const kind = metadata?.request_kind;
  let environmentMessages = 0;
  let environmentMessagesWithId = 0;
  let environmentMessagesWithTurnId = 0;
  let environmentContextCount = 0;
  let cwdCount = 0;
  let cwdValueCount = 0;
  let workspaceRootsCount = 0;
  let rootCount = 0;
  let environmentCount = 0;
  for (const value of input) {
    const item = record(value);
    if (!item || inputItemType(item) !== "message" || !rawMessageHasEnvironmentContext(item)) continue;
    environmentMessages += 1;
    if (typeof item.id === "string" && item.id.length > 0) environmentMessagesWithId += 1;
    if (itemTurnId(item) !== undefined) environmentMessagesWithTurnId += 1;
    const parts = typeof item.content === "string"
      ? [item.content]
      : Array.isArray(item.content)
        ? item.content.map(part => record(part)?.text).filter((text): text is string => typeof text === "string")
        : [];
    for (const text of parts) {
      environmentContextCount += countPattern(text, /<environment_context\b[^>]*>/gi);
      cwdCount += countPattern(text, /<cwd\b[^>]*>/gi);
      cwdValueCount += countPattern(text, /<cwd>\s*[^<\s][^<]*<\/cwd>/gi);
      workspaceRootsCount += countPattern(text, /<workspace_roots\b[^>]*>/gi);
      rootCount += countPattern(text, /<root\b[^>]*>/gi);
      environmentCount += countPattern(text, /<environment\b[^>]*>/gi);
    }
  }
  return {
    has_raw_environment_context: environmentMessages > 0,
    has_current_environment_context: hasCurrentChatGptEnvironmentContext(parsed),
    request_kind: kind === "turn" || kind === "compaction" ? kind : kind === undefined ? "missing" : "unknown",
    compaction_request: parsed._compactionRequest === true,
    rollout_identity_available: Boolean(extractChatGptThreadSpawnLineage(parsed) ?? extractChatGptRootThreadMetadata(parsed)),
    input_items: input.length,
    environment_messages: environmentMessages,
    environment_messages_with_id: environmentMessagesWithId,
    environment_messages_with_turn_id: environmentMessagesWithTurnId,
    environment_context_count: environmentContextCount,
    cwd_count: cwdCount,
    cwd_value_count: cwdValueCount,
    workspace_roots_count: workspaceRootsCount,
    root_count: rootCount,
    environment_count: environmentCount,
  };
}

export interface ChatGptUnattributedEnvironmentMessage {
  id: string;
  content: unknown;
}

/** These are claims to locate in native history, never a source of filesystem authority. */
export function unattributedChatGptEnvironmentMessages(
  parsed: CodexParsedRequest,
): ChatGptUnattributedEnvironmentMessage[] | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const currentTurnId = extractChatGptTurnIdentity(parsed).turnId;
  const messages: ChatGptUnattributedEnvironmentMessage[] = [];
  for (const value of input) {
    const item = record(value);
    if (!hasEnvironmentContextFragment(item)) continue;
    // Explicit current provenance must keep the normal current-update rejection. A native item
    // without provenance is historical only if the canonical rollout proves that exact message.
    const owner = itemTurnId(item);
    if (owner !== undefined && owner !== currentTurnId) continue;
    if (owner !== undefined || item.role !== "user"
      || typeof item.id !== "string" || !item.id) return undefined;
    messages.push({ id: item.id, content: item.content });
  }
  return messages.length > 0 ? messages : undefined;
}

function contextualUserMessage(value: Record<string, unknown>): boolean {
  const text = rawMessageText(value).trim();
  return hasEnvironmentContextFragment(value)
    || /^<subagent_notification>[\s\S]*<\/subagent_notification>$/.test(text)
    || isReadableCompactionSummaryText(text)
    || text === OPAQUE_COMPACTION_NOTE;
}

function compactionSummaryMessage(value: Record<string, unknown>): boolean {
  if (value.type !== "message" || value.role !== "user") return false;
  const text = rawMessageText(value).trim();
  return isReadableCompactionSummaryText(text) || text === OPAQUE_COMPACTION_NOTE;
}

/** The desktop injects cross-task messages as synthetic tool outputs without a call_id. */
function isDelegatedInstruction(item: Record<string, unknown> | undefined): boolean {
  if (item?.type !== "function_call_output" || item.name !== "send_message_to_thread"
    || item.namespace !== "codex_app" || item.call_id !== undefined
    || typeof item.id !== "string" || !item.id || !itemTurnId(item)?.trim()
    || typeof item.output !== "string") return false;
  // The native producer escapes &, < and > in both fields. Reject extra/nested tags and
  // malformed entities; keep the original text as task content, never environment authority.
  const fields = /^<codex_delegation>\s*<source_thread_id>([^<>]+)<\/source_thread_id>\s*<input>([^<>]+)<\/input>\s*<\/codex_delegation>$/.exec(item.output.trim());
  return fields !== null && fields.slice(1).every(text => text.trim() && !/&(?!amp;|lt;|gt;)/.test(text));
}

/** V2 agent_message instructions must still come from this child's direct parent. */
function isNativeInstruction(
  item: Record<string, unknown> | undefined,
  metadata?: Record<string, unknown>,
): item is Record<string, unknown> {
  if (inputItemType(item) === "message" && item?.role === "user") return !contextualUserMessage(item);
  if (isDelegatedInstruction(item)) return true;
  if (item?.type !== "agent_message" || typeof item.id !== "string" || !item.id
    || metadata?.subagent_kind !== "thread_spawn"
    || (metadata.request_kind !== "turn" && metadata.request_kind !== "compaction")
    || typeof metadata.thread_id !== "string" || !metadata.thread_id
    || typeof metadata.parent_thread_id !== "string" || !metadata.parent_thread_id
    || metadata.thread_id === metadata.parent_thread_id) return false;
  const agentName = metadata.agent_name;
  return typeof agentName === "string" && /^\/root\/(?:[^/]+\/)*[^/]+$/.test(agentName)
    && item.recipient === agentName
    && item.author === agentName.slice(0, agentName.lastIndexOf("/"));
}

export function hasNativeChatGptInstruction(parsed: CodexParsedRequest, input: unknown[]): boolean {
  const metadata = clientTurnMetadata(parsed);
  return input.some(value => isNativeInstruction(record(value), metadata));
}

function isTurnAbortedNotice(value: Record<string, unknown>): boolean {
  return /^<turn_aborted>[\s\S]*<\/turn_aborted>$/.test(rawMessageText(value).trim());
}

/** Native turn ids that Codex has authoritatively marked as interrupted in this thread. */
export function priorChatGptAbortedTurnIds(parsed: CodexParsedRequest): string[] {
  const currentTurnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!currentTurnId) return [];
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  return [...new Set(input.flatMap(value => {
    const item = record(value);
    const abortedTurnId = item ? itemTurnId(item) : undefined;
    return inputItemType(item) === "message"
      && item !== undefined
      && item.role === "user"
      && isTurnAbortedNotice(item)
      && abortedTurnId !== undefined
      && abortedTurnId !== currentTurnId
      ? [abortedTurnId]
      : [];
  }))];
}

/**
 * Return the latest instruction owned by the current native Codex turn.
 *
 * Provider rounds replay the same instruction and steering appends a newer one. Remote
 * compaction uses this revision to identify and stop the superseded browser response; once Codex
 * installs the replacement history, the immediate continuation starts a fresh browser response
 * under the same logical task revision.
 */
export function extractChatGptTurnUserRevision(parsed: CodexParsedRequest): unknown {
  const identity = extractChatGptTurnIdentity(parsed);
  const turnId = identity.turnId;
  if (!turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const revision = latestChatGptTurnUserRevision(parsed, turnId);
  if (!revision) throw new Error("ChatGPT web requires a current-turn user message for browser-session replay");
  // A pre-turn compact may summarize an earlier user message before native Codex continues
  // under its new turn id without adding a new human message. Accept only our exact completed
  // checkpoint; an arbitrary older prompt is still not a new instruction or a valid handoff.
  if (revision.turnId !== undefined && revision.turnId !== turnId
    && (priorChatGptAbortedTurnIds(parsed).includes(revision.turnId)
      || !isAcceptedCompactionContinuation(parsed, identity, revision))) {
    throw new Error(CHATGPT_TURN_REVISION_CONFLICT_MESSAGE);
  }
  return revision.content;
}

function latestChatGptTurnUserRevision(parsed: CodexParsedRequest, expectedTurnId?: string): ChatGptTurnUserRevision | undefined {
  return requestCarriedChatGptInstructionRevision(parsed, expectedTurnId)
    ?? recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed))?.source;
}

interface ContinuityInstructionSelection {
  input: unknown[];
  scope?: string;
  compaction?: boolean;
  carried: Map<string | undefined, number>;
  index?: number;
  inputs: Map<string, number[]>;
}

// Request-local positions share identity and grouping decisions without copying source records.
const continuityInstructionSelections = new WeakMap<CodexParsedRequest, ContinuityInstructionSelection>();

function continuityInstructionSelection(parsed: CodexParsedRequest, input: unknown[]): ContinuityInstructionSelection | undefined {
  if (parsed._conversationPolicy !== "continuity-first") return undefined;
  const cached = continuityInstructionSelections.get(parsed);
  if (cached && cached.input === input && cached.scope === parsed._continuityScope
    && cached.compaction === parsed._compactionRequest) return cached;
  const selection = { input, scope: parsed._continuityScope, compaction: parsed._compactionRequest,
    carried: new Map<string | undefined, number>(), inputs: new Map<string, number[]>() };
  continuityInstructionSelections.set(parsed, selection);
  return selection;
}

/** Read request-carried identity without invoking checkpoint recovery. */
export function requestCarriedChatGptInstructionRevision(parsed: CodexParsedRequest, expectedTurnId?: string): ChatGptTurnUserRevision | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  const selection = continuityInstructionSelection(parsed, input);
  if (selection?.carried.has(expectedTurnId)) {
    const index = selection.carried.get(expectedTurnId)!;
    return index >= 0 ? userRevision(input[index], expectedTurnId, metadata, true) : undefined;
  }
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const revision = userRevision(input[index], expectedTurnId, metadata, parsed._conversationPolicy === "continuity-first");
    if (revision) {
      selection?.carried.set(expectedTurnId, index);
      return revision;
    }
  }
  selection?.carried.set(expectedTurnId, -1);
  return undefined;
}

/** Index of the latest native instruction that is physically present in this request. */
export function chatGptCurrentInstructionIndex(parsed: CodexParsedRequest): number {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const identity = extractChatGptTurnIdentity(parsed);
  if (parsed._compactionRequest) {
    identity.turnId = extractChatGptCompactionSourceRevision(parsed).turnId
      ?? parsed._chatGptCompactionSourceTurnId ?? identity.turnId;
  }
  const metadata = clientTurnMetadata(parsed);
  const checkpoint = parsed._conversationPolicy === "continuity-first" && !parsed._compactionRequest
    ? recoverCompactionInstruction(parsed, identity) : undefined;
  const selection = continuityInstructionSelection(parsed, input);
  if (selection?.index !== undefined) return selection.index;
  const remember = (index: number): number => {
    if (selection) selection.index = index;
    return index;
  };
  let retainedSourceIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (checkpoint && index <= checkpoint.summaryIndex) {
      const item = record(input[index]);
      const sourceId = checkpoint.source.itemId;
      const sameSource = sourceId
        ? typeof item?.id === "string" && (parsed._chatGptMessageIdAliases?.[item.id] ?? item.id)
          === (parsed._chatGptMessageIdAliases?.[sourceId] ?? sourceId)
        : checkpoint.source.turnId !== undefined && itemTurnId(item) === checkpoint.source.turnId
          && isNativeInstruction(item, metadata);
      if (sameSource && retainedSourceIndex < 0) retainedSourceIndex = index;
      continue;
    }
    const revision = userRevision(input[index], identity.turnId, metadata);
    if (!revision && itemTurnId(input[index]) === undefined
      && parsed._conversationPolicy === "continuity-first" && !parsed._compactionRequest
      && isNativeInstruction(record(input[index]), metadata)) {
      throw continuityError("continuity_source_unproven", "The current native instruction has no item or turn identity.");
    }
    if (!revision) continue;
    if (isRetainedCompactionSourceInstruction(parsed, input[index])) {
      if (retainedSourceIndex < 0) retainedSourceIndex = index;
    } else if (revision.turnId === undefined || revision.turnId === identity.turnId) return remember(index);
  }
  return remember(retainedSourceIndex);
}

/** Use the same native instruction for work identity and incremental input selection. */
export function chatGptCurrentInstructionRevision(parsed: CodexParsedRequest): ChatGptTurnUserRevision | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const index = chatGptCurrentInstructionIndex(parsed);
  return index >= 0 ? userRevision(input[index], undefined, clientTurnMetadata(parsed), true)
    : recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed))?.source;
}

/** Preserve the instruction roles that the prompt compiler treats differently. */
export function chatGptInstructionEnvelope(item: Record<string, unknown>): Record<string, unknown> {
  return item.type === "agent_message"
    ? { role: "agent_message", author: item.author, recipient: item.recipient }
    : { role: item.type === "function_call_output" ? "tool_result" : item.role };
}

/** Grouped native instructions retain their sibling content independently of environment updates. */
export function chatGptInstructionContent(item: Record<string, unknown>): unknown {
  if (item.type === "function_call_output") return item.output;
  if (!hasEnvironmentContextFragment(item) || !Array.isArray(item.content)) return item.content;
  const environmentTexts = new Set(rawMessageEnvironmentParts(item).map(part => part.text));
  return item.content.filter(part => {
    const text = record(part)?.text;
    return typeof text !== "string" || !environmentTexts.has(text);
  });
}

/** Reintroduce all native instruction items belonging to the current incremental work. */
export function continuityCurrentInstructionInput(
  parsed: CodexParsedRequest,
  previous?: { instructionIdentity?: string; nativeTurnId?: string; trustedLowerBound?: number },
  includeRetainedSource = false,
): unknown[] {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const index = chatGptCurrentInstructionIndex(parsed);
  const selection = continuityInstructionSelection(parsed, input);
  const selectionKey = JSON.stringify([previous?.instructionIdentity ?? null, previous?.nativeTurnId ?? null,
    previous?.trustedLowerBound ?? null, includeRetainedSource]);
  const cached = selection?.inputs.get(selectionKey);
  if (cached) return cached.map(candidate => structuredClone(input[candidate]));
  const remember = (indices: number[]): unknown[] => {
    selection?.inputs.set(selectionKey, indices);
    return indices.map(candidate => structuredClone(input[candidate]));
  };
  const retainCurrentSource = includeRetainedSource && isRetainedCompactionSourceInstruction(parsed, input[index]);
  const identity = extractChatGptTurnIdentity(parsed);
  if (parsed._compactionRequest) {
    identity.turnId = extractChatGptCompactionSourceRevision(parsed).turnId
      ?? parsed._chatGptCompactionSourceTurnId ?? identity.turnId;
  }
  const metadata = clientTurnMetadata(parsed);
  const prior = previous;
  const currentTurnOwned = userRevision(input[index], identity.turnId, metadata)?.turnId === identity.turnId;
  // Codex reuses the instruction prefix of each execution-history window across turns.
  // Its turn_id records creation, while native content kinds identify persistent groups.
  const requestPrefix = new Set<number>();
  const prefixKinds = new Set(["model.base_instructions", "generic.developer_instructions",
    "host_skills.instructions", "permissions.instructions", "collaboration_mode.instructions",
    "plugins.instructions", "plugins.usage_instructions", "apps.instructions",
    "multi_agent.mode_instructions", "multi_agent.role_instructions", "multi_agent.usage_hint",
    "skills.catalog", "skills.instructions", "cloud_skills.instructions", "memories.instructions",
    "plugins.recommendations", "environments.instructions", "persistent_mode.instructions",
    "token_budget.context_window", "token_budget.context_window_guidance", "tools.deferred_namespaces",
    "git_attribution.instructions", "managed_config.developer_instructions", "model_switch.instructions",
    "agents_md.instructions", "environments.environment_context"]);
  const checkpointIndex = prior?.trustedLowerBound;
  const prefixStarts = [0, ...(checkpointIndex !== undefined && checkpointIndex >= 0 ? [checkpointIndex + 1] : [])];
  for (const start of prefixStarts) {
    for (let candidate = start; candidate < input.length; candidate += 1) {
      const item = record(input[candidate]);
      if (item?.type === "additional_tools") continue;
      const envelope = inputItemType(item) === "message" && (item?.role === "system" || item?.role === "developer");
      const grouped = hasEnvironmentContextFragment(item) && Array.isArray(item.content);
      if (!envelope && !grouped) break;
      const kinds = messageContentKinds(item!);
      // A workspace without AGENTS still has a pure environment item in this prefix.
      if (itemTurnId(item) === undefined || itemTurnId(item) === identity.turnId
        || (kinds && kinds.length > 0 && kinds.every(kind => prefixKinds.has(kind)))) requestPrefix.add(candidate);
    }
  }
  let lowerBound = checkpointIndex !== undefined && Number.isInteger(checkpointIndex)
    && checkpointIndex >= 0 && checkpointIndex < input.length
    ? checkpointIndex
    : -1;
  if (index < 0 && lowerBound < 0) return remember([]);
  let predecessorDefinesBoundary = false;
  if (prior?.instructionIdentity && index > lowerBound) {
    const priorInstructionIdentity = prior.instructionIdentity;
    if (priorInstructionIdentity === `turn:${identity.turnId}`) {
      throw continuityError("continuity_source_unproven", "The current native turn has no distinct steering instruction identity.");
    }
    for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
      const revision = userRevision(input[candidate], identity.turnId, metadata);
      if (!revision) continue;
      const canonical = revision.itemId
        ? parsed._chatGptMessageIdAliases?.[revision.itemId] ?? revision.itemId
        : undefined;
      const matchesPriorTurnFallback = prior.nativeTurnId !== undefined
        && priorInstructionIdentity === `turn:${prior.nativeTurnId}`
        && revision.turnId === prior.nativeTurnId;
      if (canonical === priorInstructionIdentity || matchesPriorTurnFallback) {
        predecessorDefinesBoundary = candidate >= lowerBound;
        lowerBound = Math.max(lowerBound, candidate);
        break;
      }
    }
    if (lowerBound < 0 && !(currentTurnOwned && prior.nativeTurnId !== undefined
      && prior.nativeTurnId !== identity.turnId)) {
      throw continuityError("continuity_source_unproven", "The accepted predecessor instruction cannot be located in the current request.");
    }
  }
  // Execution output cannot prove a new increment. It only makes an instruction
  // without native turn ownership ambiguous with already completed work.
  let executionOutputIndex = -1;
  for (let candidate = lowerBound + 1; candidate < index; candidate += 1) {
    const item = record(input[candidate]);
    if (!item || userRevision(item, identity.turnId, metadata)) continue;
    if (item.role === "assistant" || ["function_call", "custom_tool_call", "function_call_output",
      "custom_tool_call_output", "tool_search_call", "tool_search_output"].includes(String(item.type))) {
      executionOutputIndex = candidate;
    }
  }
  const currentEnvironmentItems = new Set(currentChatGptEnvironmentParts(parsed).map(part => part.item));
  // API-key Codex omits per-item provenance. Its rebuilt window has a complete native
  // preamble followed by one instruction; additional unowned history remains ambiguous.
  const unownedWindowInstruction = checkpointIndex !== undefined && checkpointIndex >= 0 && index > checkpointIndex
    && prior?.nativeTurnId !== undefined && prior.nativeTurnId !== identity.turnId
    && userRevision(input[index], identity.turnId, metadata)?.turnId === undefined
    && [...requestPrefix].some(candidate => candidate > checkpointIndex && hasEnvironmentContextFragment(record(input[candidate])))
    && input.slice(checkpointIndex + 1, index).every((_, offset) => requestPrefix.has(checkpointIndex + 1 + offset));
  let trailingOutput = false;
  const selected: number[] = [];
  for (let candidate = 0; candidate < input.length; candidate += 1) {
    const item = input[candidate];
    const message = record(item);
    const revision = userRevision(item, identity.turnId, metadata);
    const envelope = inputItemType(message) === "message"
      && (message?.role === "system" || message?.role === "developer");
    const grouped = Boolean(message && currentEnvironmentItems.has(message) && Array.isArray(message.content)
      && (chatGptInstructionContent(message) as unknown[]).length > 0);
    const supplemental = envelope || grouped;
    const nativeTurnId = revision?.turnId ?? itemTurnId(item);
    const requestWide = requestPrefix.has(candidate);
    if (candidate <= lowerBound && !requestWide && !(nativeTurnId === identity.turnId
      && (supplemental || (currentTurnOwned && prior?.nativeTurnId !== identity.turnId)))) continue;
    if (!revision && itemTurnId(item) === undefined && isNativeInstruction(message, metadata)
      && (!parsed._compactionRequest || candidate <= index)) {
      if (!prior && candidate < executionOutputIndex) continue;
      throw continuityError("continuity_source_unproven", "The current native instruction has no item or turn identity.");
    }
    if (candidate > index && !envelope && !revision && message
      && (message.role === "assistant" || ["function_call", "custom_tool_call", "function_call_output",
        "custom_tool_call_output", "tool_search_call", "tool_search_output", "compaction"].includes(String(message.type)))) {
      trailingOutput = true;
    }
    if ((!revision && !supplemental && !requestWide) || (!retainCurrentSource && isRetainedCompactionSourceInstruction(parsed, item))) continue;
    if (nativeTurnId !== undefined && nativeTurnId !== identity.turnId && !requestWide) continue;
    if (envelope && candidate > index && nativeTurnId === undefined && trailingOutput) {
      throw continuityError("continuity_source_unproven", "A trailing instruction without native turn ownership follows execution output.");
    }
    if (nativeTurnId === undefined && candidate < executionOutputIndex && !requestWide) {
      if (prior) {
        throw continuityError("continuity_source_unproven", "An instruction without native turn ownership cannot be distinguished from completed work.");
      }
      // Initial upload still includes all history. Only its current-work comparison
      // excludes unowned instructions that already have execution output.
      continue;
    }
    // A predecessor before a moved checkpoint does not prove ownership of its later items.
    if (prior?.instructionIdentity && !predecessorDefinesBoundary && !requestWide
      && !(unownedWindowInstruction && candidate === index)
      && !(supplemental && (nativeTurnId === identity.turnId || candidate > index))
      && !(supplemental && nativeTurnId === undefined && currentTurnOwned && prior.nativeTurnId !== identity.turnId)
      && (nativeTurnId !== identity.turnId || prior.nativeTurnId === identity.turnId)) {
      throw continuityError(
        "continuity_source_unproven",
        "The checkpoint boundary cannot distinguish this instruction from completed history.",
      );
    }
    selected.push(candidate);
  }
  return remember(selected);
}

/** First entry requires a real current instruction, not a recovered checkpoint or tool continuation. */
export function hasInitialChatGptTurnInstruction(parsed: CodexParsedRequest): boolean {
  if (parsed._compactionRequest) return false;
  const identity = extractChatGptTurnIdentity(parsed);
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  if (!identity.threadId || !identity.turnId) return false;
  const currentIndex = parsed._conversationPolicy === "continuity-first"
    ? chatGptCurrentInstructionIndex(parsed) : undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (!item) continue;
    const revision = userRevision(item, identity.turnId, metadata);
    if (revision) {
      if (currentIndex !== undefined && index !== currentIndex) continue;
      return revision.turnId === undefined || revision.turnId === identity.turnId;
    }
    // Already-started work is not a fresh ordinary instruction merely because its older user
    // message is still in the request. Context/environment updates do not cross this boundary.
    if (item.role === "assistant" || (typeof item.type === "string"
      && ["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output", "tool_search_call", "tool_search_output"].includes(item.type))) return false;
  }
  return false;
}

/** Reintroduce only the current operational envelope, never historical task messages. */
export function continuityCurrentEnvironmentInput(parsed: CodexParsedRequest, selectedInstructions: unknown[] = []): unknown[] {
  const selected = new Set(selectedInstructions.map(canonicalJson));
  return currentChatGptEnvironmentParts(parsed).filter(part => !selected.has(canonicalJson(part.item))).map(part => ({
    ...part.item,
    content: [{ type: "input_text", text: part.text }],
    internal_chat_message_metadata_passthrough: {
      ...record(part.item.internal_chat_message_metadata_passthrough),
      content_item_kinds: ["environments.environment_context"],
    },
  }));
}

/** A retained source copied by the checkpoint codec is not a new instruction to execute. */
export function isRetainedCompactionSourceInstruction(parsed: CodexParsedRequest, value: unknown): boolean {
  const identity = extractChatGptTurnIdentity(parsed);
  const revision = userRevision(value, identity.turnId, clientTurnMetadata(parsed), parsed._conversationPolicy === "continuity-first");
  const accepted = recoverCompactionInstruction(parsed, identity);
  return Boolean(revision && accepted
    && (!revision.itemId || !accepted.source.itemId
      || (parsed._chatGptMessageIdAliases?.[revision.itemId] ?? revision.itemId)
        === (parsed._chatGptMessageIdAliases?.[accepted.source.itemId] ?? accepted.source.itemId))
    && isAcceptedCompactionContinuation(parsed, identity, revision));
}

function userRevision(value: unknown, expectedTurnId?: string, metadata?: Record<string, unknown>, includeEnvelope = false): ChatGptTurnUserRevision | undefined {
  const item = record(value);
  if (!isNativeInstruction(item, metadata)) return undefined;
  const messageTurnId = itemTurnId(item);
  // An abort notice is contextual only when native metadata identifies its earlier turn.
  if (inputItemType(item) === "message" && isTurnAbortedNotice(item) && expectedTurnId !== undefined
    && messageTurnId !== undefined && messageTurnId !== expectedTurnId) return undefined;
  const itemId = typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
  if (messageTurnId === undefined && itemId === undefined) return undefined;
  return { content: item.type === "function_call_output" ? item.output : item.content,
    ...(includeEnvelope ? { instructionEnvelope: chatGptInstructionEnvelope(item) } : {}),
    ...(messageTurnId ? { turnId: messageTurnId } : {}),
    ...(itemId ? { itemId } : {}) };
}

/** Canonical instruction order distinguishes new steering from a delayed older request. */
export function chatGptTurnUserRevisionHistory(parsed: CodexParsedRequest): ChatGptTurnUserRevision[] {
  const body = record(parsed._rawBody);
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const metadata = clientTurnMetadata(parsed);
  const revisions = (Array.isArray(body?.input) ? body.input : []).flatMap(value => {
    const revision = userRevision(value, turnId, metadata, parsed._conversationPolicy === "continuity-first");
    return revision ? [revision] : [];
  });
  if (revisions.length > 0) return revisions;
  const recovered = recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed));
  return recovered ? [recovered.source] : [];
}

export interface ChatGptTrustedUserText {
  sourceMessageId: string;
  content: string;
  /** Preserve the native representation, including its role and content-part ordering. */
  item: Record<string, unknown>;
}

/**
 * This narrow provenance check is intentionally separate from instruction history, which also
 * includes delegated agent messages. Older API-key Codex omits content kinds, but still supplies
 * the native turn owner, message role and stable item identity. Typed native fragments never
 * inherit that compatibility path.
 */
export function trustedChatGptTaskUpdateUserText(
  value: unknown,
  turnId: string,
): ChatGptTrustedUserText | undefined {
  const item = record(value);
  if (!item || inputItemType(item) !== "message" || item.role !== "user"
    || itemTurnId(item) !== turnId || typeof item.id !== "string" || !item.id
    || contextualUserMessage(item) || item.origin !== undefined || item.author !== undefined
    || item.recipient !== undefined) return undefined;
  const parts = typeof item.content === "string" ? [{ type: "input_text", text: item.content }]
    : Array.isArray(item.content) ? item.content : [];
  if (parts.length === 0 || parts.some(value => {
    const part = record(value);
    return !part || !["input_text", "text"].includes(String(part.type)) || typeof part.text !== "string";
  })) return undefined;
  const kindsValue = record(item.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  if (kindsValue !== undefined && (!Array.isArray(kindsValue) || kindsValue.length !== parts.length
    || kindsValue.some(kind => kind !== "user.text"))) return undefined;
  const content = parts.map(value => String(record(value)!.text)).join("\n");
  if (!content.trim()) return undefined;
  // Native preambles on old wires have no content kind. They are frozen prefix evidence, never
  // a newly authorized human instruction. Text inside tool outputs is never examined here.
  if (kindsValue === undefined && (/^# AGENTS\.md instructions\b/.test(content.trimStart())
    || /^<(?:environment_context|subagent_notification|skills_instructions|permissions|collaboration_mode|codex_delegation)\b/.test(content.trimStart()))) return undefined;
  return { sourceMessageId: item.id, content, item };
}

/** A layout marker only; it grants no checkpoint, environment or user-instruction authority. */
export function isChatGptReadonlyCompactionBoundary(value: unknown): boolean {
  const item = record(value);
  if (!item) return false;
  if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
    return typeof item.encrypted_content === "string" && decodeCompactionSummary(item.encrypted_content) !== null;
  }
  return inputItemType(item) === "message" && item.role === "user"
    && isReadableCompactionSummaryText(rawMessageText(item));
}

/** Compare retained requirements separately from compaction summaries and execution outputs. */
export function chatGptReadonlyCompactionInstructions(parsed: CodexParsedRequest, input?: readonly unknown[]): Record<string, unknown>[] {
  const body = record(parsed._rawBody);
  const values = input ?? (Array.isArray(body?.input) ? body.input : []);
  return values.flatMap(value => {
    const item = record(value);
    if (!item || isChatGptReadonlyCompactionBoundary(item)) return [];
    return ["user", "system", "developer"].includes(String(item.role)) || item.type === "agent_message"
      || (item.type === "function_call_output" && item.call_id === undefined) ? [item] : [];
  });
}

/** A remote compaction may summarize an instruction from an earlier turn. */
export function extractChatGptCompactionSourceRevision(parsed: CodexParsedRequest): ChatGptTurnUserRevision {
  if (!parsed._compactionRequest) throw new Error("ChatGPT web compaction source requires a compaction request");
  const revision = latestChatGptTurnUserRevision(parsed, extractChatGptTurnIdentity(parsed).turnId);
  if (!revision) throw new Error("ChatGPT web compaction requires a source user message");
  return revision;
}

/** Capture the producer's v1 representation once, with the committed source. */
export function extractChatGptCompactV1SourceRevision(parsed: CodexParsedRequest, summary: string): ChatGptTurnUserRevision {
  const body = record(parsed._rawBody);
  const input = buildCompactV1Output(extractCompactUserMessages(
    parsed._compactionOutput === "message" && Array.isArray(body?.input) ? body.input.slice(0, -1) : body?.input,
  ), summary);
  const identity = extractChatGptTurnIdentity(parsed);
  const metadata = clientTurnMetadata(parsed);
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const source = userRevision(input[index], identity.turnId, metadata, parsed._conversationPolicy === "continuity-first");
    if (source) return source;
  }
  return extractChatGptCompactionSourceRevision(parsed);
}

/** A completed checkpoint binds an older instruction to this exact continuing native turn. */
export function isChatGptCompactionContinuation(parsed: CodexParsedRequest): boolean {
  const identity = extractChatGptTurnIdentity(parsed);
  const revision = latestChatGptTurnUserRevision(parsed, identity.turnId);
  return revision?.turnId !== undefined && identity.turnId !== undefined
    && revision.turnId !== identity.turnId
    && !priorChatGptAbortedTurnIds(parsed).includes(revision.turnId)
    && isAcceptedCompactionContinuation(parsed, identity, revision);
}

/** Parse a claim only: the caller must compare it with this turn's native rollout authority. */
export function extractChatGptContinuationEnvironmentClaim(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const body = record(parsed._rawBody);
  const updates = (Array.isArray(body?.input) ? body.input : []).flatMap(value => {
    const item = record(value);
    if (inputItemType(item) !== "message" || !item || item.role !== "user" || itemTurnId(item) !== turnId
      || typeof item.id !== "string" || !item.id) return [];
    // Native compaction groups plugins, instructions and environment into sibling content parts.
    // Read the environment part without treating the surrounding preamble as part of its XML.
    const parts = typeof item.content === "string" ? [item.content]
      : Array.isArray(item.content) ? item.content.map(part => record(part)?.text) : [];
    return parts.flatMap(value => {
      if (typeof value !== "string") return [];
      const text = value.trim();
      return /^<environment_context>[\s\S]*<\/environment_context>$/.test(text) ? [text] : [];
    });
  });
  if (updates.length !== 1) {
    throw new TrustedCodexEnvironmentValidationError(
      "Compaction continuation requires one current native environment claim",
    );
  }
  return parseChatGptEnvironmentText(parsed, updates[0]!);
}

/**
 * Steering can separate the original environment/instruction pair from the active instruction.
 * Git workspace metadata need not list every native filesystem root. Return that earlier claim
 * only for a same-turn pair; the store must compare it with the current canonical rollout.
 */
export function extractChatGptSteeringEnvironmentClaim(parsed: CodexParsedRequest): ChatGptTurnEnvironment | undefined {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!turnId) return undefined;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  const activeIndex = input.findLastIndex(value => isNativeInstruction(record(value), metadata));
  const active = record(input[activeIndex]);
  if (itemTurnId(active) !== turnId || typeof active?.id !== "string" || !active.id) return undefined;

  // Do not skip an unrecognized update or use one of several competing envelopes. Older,
  // explicitly attributed history is not a current claim; untagged XML remains unproven.
  const claims = input.flatMap((value, index) => {
    const item = record(value);
    if (!hasEnvironmentContextFragment(item)) return [];
    const owner = itemTurnId(item);
    return owner === undefined || owner === turnId ? [{ item, index }] : [];
  });
  if (claims.length !== 1) return undefined;
  const claim = claims[0]!;
  if (claim.item.role !== "user" || itemTurnId(claim.item) !== turnId
    || typeof claim.item.id !== "string" || !claim.item.id) return undefined;
  const parts = Array.isArray(claim.item.content) ? claim.item.content : [];
  if (parts.filter(part => /<\/?environment_context\b/i.test(String(record(part)?.text ?? ""))).length !== 1) return undefined;

  for (let index = claim.index + 1; index < activeIndex; index += 1) {
    const instruction = record(input[index]);
    if (typeof instruction?.id !== "string" || !instruction.id) continue;
    const text = environmentBeforeUser(input, index, turnId, metadata);
    if (text) return parseChatGptEnvironmentText(parsed, text);
  }
  return undefined;
}

/**
 * Native world-state diffs omit unchanged cwd/shell at midnight but repeat the filesystem
 * profile. Recognize the observed unrestricted calendar fragment as a claim only: the store
 * still requires this exact turn's native rollout and corroborating current sandbox metadata.
 * Unknown profiles/fields are deliberately not classified as permission-neutral updates.
 */
export function hasChatGptCalendarEnvironmentDelta(parsed: CodexParsedRequest): boolean {
  const metadata = clientTurnMetadata(parsed);
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!metadata || !turnId) return false;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const activeIndex = input.findLastIndex(value => isNativeInstruction(record(value), metadata));
  const active = record(input[activeIndex]);
  if (itemTurnId(active) !== turnId || typeof active?.id !== "string" || !active.id) return false;

  let deltas = 0;
  for (let index = activeIndex + 1; index < input.length; index += 1) {
    const item = record(input[index]);
    if (!hasEnvironmentContextFragment(item)) continue;
    if (item.role !== "user" || itemTurnId(item) !== turnId || typeof item.id !== "string" || !item.id
      || !hasAssistantOutputBetween(input, activeIndex + 1, index)) return false;
    const text = rawMessageText(item).trim();
    // Match the whole native fragment, not just the presence of a disabled profile: another
    // profile, a malformed cwd, or any additional permission declaration must fail closed.
    if (!/^<environment_context>\s*<current_date>\d{4}-\d{2}-\d{2}<\/current_date>\s*(?:<timezone>[^<>]+<\/timezone>\s*)?<filesystem>\s*<permission_profile type="disabled">\s*<file_system type="unrestricted"\s*\/>\s*<\/permission_profile>\s*<\/filesystem>\s*<\/environment_context>$/.test(text)
      || !sandboxMetadataMatchesEnvironment(canonicalSandboxMetadata(metadata), text)
      || [metadata.sandbox_mode, metadata.sandbox].some(value => (
        value !== undefined && !sandboxMetadataMatchesEnvironment(value, text)
      ))) return false;
    deltas += 1;
  }
  return deltas > 0;
}

function environmentBeforeUser(input: unknown[], userIndex: number, expectedTurnId?: string, metadata?: Record<string, unknown>): string | undefined {
  if (userIndex <= 0) return undefined;
  const user = record(input[userIndex]);
  if (!isNativeInstruction(user, metadata)) return undefined;

  const userTurnId = itemTurnId(user);
  if (!userTurnId || (expectedTurnId && userTurnId !== expectedTurnId)) return undefined;

  let candidateIndex = userIndex - 1;
  let candidate = record(input[candidateIndex]);
  while (inputItemType(candidate) === "message" && candidate?.role === "developer") {
    const developerTurnId = itemTurnId(candidate);
    if (developerTurnId !== userTurnId) return undefined;
    candidateIndex -= 1;
    candidate = record(input[candidateIndex]);
  }
  if (inputItemType(candidate) !== "message" || candidate?.role !== "user") return undefined;

  const candidateTurnId = itemTurnId(candidate);
  if (candidateTurnId !== userTurnId) return undefined;

  const content = Array.isArray(candidate.content) ? candidate.content : [];
  for (const part of content) {
    const text = record(part)?.text;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (/^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed)) return trimmed;
  }
  return undefined;
}

function sandboxTypeFromEnvironment(text: string): ChatGptSandboxPolicy["type"] | undefined {
  const unrestricted = /<permission_profile\s+type=["']disabled["'][^>]*>[\s\S]*?<file_system\s+type=["']unrestricted["'][^>]*\/?\s*>/i.test(text)
    || /<sandbox_mode>danger-full-access<\/sandbox_mode>/i.test(text);
  const restrictedFileSystem = /<permission_profile\s+type=["']managed["'][^>]*>[\s\S]*?<file_system\s+type=["']restricted["'][^>]*>([\s\S]*?)<\/file_system>/i.exec(text);
  const restrictedHasWriteEntry = restrictedFileSystem !== null
    && /<entry\s+access=["']write["'][^>]*>/i.test(restrictedFileSystem[1]!);
  const workspaceWrite = /<sandbox_mode>workspace-write<\/sandbox_mode>/i.test(text)
    || restrictedHasWriteEntry;
  const readOnly = /<sandbox_mode>read-only<\/sandbox_mode>/i.test(text)
    || (restrictedFileSystem !== null && !restrictedHasWriteEntry);
  if (Number(unrestricted) + Number(workspaceWrite) + Number(readOnly) !== 1) return undefined;
  return unrestricted ? "dangerFullAccess" : workspaceWrite ? "workspaceWrite" : "readOnly";
}

type ChatGptMetadataSandbox = ChatGptSandboxPolicy["type"] | "platform";

function canonicalSandboxMetadata(metadata: Record<string, unknown>): unknown {
  return metadata.sandbox_mode ?? metadata.sandbox;
}

function sandboxTypeFromMetadata(value: unknown): ChatGptMetadataSandbox | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase().replaceAll("_", "-")) {
    case "none":
    case "unrestricted":
    case "danger-full-access":
      return "dangerFullAccess";
    case "workspace-write":
      return "workspaceWrite";
    case "read-only":
      return "readOnly";
    // Codex CLI reports the host sandbox mechanism here, while the XML envelope carries the
    // effective filesystem policy. Keep the platform tag as a separate class and validate the
    // actual policy below instead of guessing write access from the platform name.
    case "windows-sandbox":
    case "windows-elevated":
    case "seatbelt":
    case "seccomp":
      return "platform";
    default:
      return undefined;
  }
}

function sandboxMetadataMatchesEnvironment(
  metadataValue: unknown,
  environmentText: string,
): boolean {
  const metadataSandbox = sandboxTypeFromMetadata(metadataValue);
  const environmentSandbox = sandboxTypeFromEnvironment(environmentText);
  if (!metadataSandbox || !environmentSandbox) return false;
  if (metadataSandbox === "platform") {
    return environmentSandbox === "workspaceWrite" || environmentSandbox === "readOnly";
  }
  return metadataSandbox === environmentSandbox;
}

function environmentMatchesCanonicalMetadata(
  environmentText: string,
  metadata: Record<string, unknown>,
  requireMetadataBoundRoots: boolean,
): boolean {
  const metadataSandboxValue = canonicalSandboxMetadata(metadata);
  const metadataSandbox = sandboxTypeFromMetadata(metadataSandboxValue);
  if (!metadataSandbox) return false;
  const workspaces = record(metadata.workspaces);
  const metadataRoots = workspaces ? Object.keys(workspaces) : [];
  if (metadataRoots.some(path => !isAbsolute(path))) return false;
  const normalizedMetadataRoots = [...new Set(metadataRoots.map(pathIdentity))];

  let cwdMatches: string[];
  try {
    cwdMatches = environmentCwdMatches(environmentText, normalizedMetadataRoots)
      .map(value => decodeXmlText(value.trim()));
  } catch {
    return false;
  }
  if (cwdMatches.length !== 1 || !isAbsolute(cwdMatches[0]!)) return false;
  const rootMatches = [...environmentText.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/g)]
    .flatMap(section => [...section[0].matchAll(/<root>([^<]+)<\/root>/g)].map(match => decodeXmlText(match[1]!.trim())));
  const declaredRootValues = rootMatches.length > 0 ? rootMatches : cwdMatches;
  if (declaredRootValues.some(path => !isAbsolute(path))) return false;
  const declaredRoots = [...new Set(declaredRootValues.map(pathIdentity))];
  const cwd = pathIdentity(cwdMatches[0]!);
  if (normalizedMetadataRoots.length > 0
    && !normalizedMetadataRoots.some(root => matchesPath(root, cwd))) return false;
  if (requireMetadataBoundRoots && (
    normalizedMetadataRoots.length === 0
    || declaredRoots.some(root => (
      !normalizedMetadataRoots.some(metadataRoot => matchesPath(metadataRoot, root))
      && !isCurrentOrParentThreadVisualizationRoot(root, metadata)
    ))
  )) return false;
  if (!declaredRoots.some(root => matchesPath(root, cwd))) return false;
  return sandboxMetadataMatchesEnvironment(metadataSandboxValue, environmentText);
}

function isCurrentOrParentThreadVisualizationRoot(path: string, metadata: Record<string, unknown>): boolean {
  const threadIds = [metadata.thread_id, metadata.parent_thread_id]
    .filter((value): value is string => typeof value === "string")
    .map(value => process.platform === "win32" ? value.trim().toLowerCase() : value.trim())
    .filter(Boolean);
  if (threadIds.length === 0) return false;

  // Codex advertises its task-scoped visualization output directory in workspace_roots but omits
  // it from Git-oriented turn metadata. Authenticate that one auxiliary shape by both its private
  // Codex home and current or parent thread id; arbitrary roots and unrelated output remain untrusted.
  const configuredCodexHome = process.env.CODEX_HOME?.trim();
  const codexHome = resolve(configuredCodexHome || join(homedir(), ".codex"));
  const visualizationBase = pathIdentity(join(codexHome, "visualizations"));
  const rel = relative(visualizationBase, pathIdentity(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;

  const parts = rel.split(sep);
  return parts.length === 4
    && /^\d{4}$/.test(parts[0]!)
    && /^(?:0[1-9]|1[0-2])$/.test(parts[1]!)
    && /^(?:0[1-9]|[12]\d|3[01])$/.test(parts[2]!)
    && threadIds.includes(parts[3]!);
}

function canonicalMetadataEnvironmentBeforeUser(
  input: unknown[],
  userIndex: number,
  metadata: Record<string, unknown> | undefined,
  requireMetadataBoundRoots = false,
): string | undefined {
  if (userIndex <= 0 || !metadata) return undefined;
  const metadataTurnId = typeof metadata.turn_id === "string" ? metadata.turn_id.trim() : "";
  const metadataSandbox = sandboxTypeFromMetadata(canonicalSandboxMetadata(metadata));
  if (!metadataTurnId || !metadataSandbox) return undefined;

  const user = record(input[userIndex]);
  if (!isNativeInstruction(user, metadata) || typeof user.id !== "string" || !user.id) return undefined;
  const userTurnId = itemTurnId(user);
  if (userTurnId !== undefined && userTurnId !== metadataTurnId) return undefined;

  return canonicalMetadataEnvironmentBefore(input, userIndex, metadata, requireMetadataBoundRoots);
}

/** Read an envelope before a proven instruction or completed checkpoint, never as the instruction. */
function canonicalMetadataEnvironmentBefore(
  input: unknown[],
  anchorIndex: number,
  metadata: Record<string, unknown>,
  requireMetadataBoundRoots = false,
): string | undefined {
  const metadataTurnId = metadata.turn_id;
  if (typeof metadataTurnId !== "string" || !metadataTurnId.trim()) return undefined;

  let candidateIndex = anchorIndex - 1;
  let candidate = record(input[candidateIndex]);
  while (inputItemType(candidate) === "message"
    && candidate !== undefined
    && (candidate.role === "developer" || compactionSummaryMessage(candidate))) {
    const developerTurnId = itemTurnId(candidate);
    const serverOwnedId = typeof candidate.id === "string" && candidate.id.length > 0;
    if (developerTurnId === undefined ? !serverOwnedId : developerTurnId !== metadataTurnId) return undefined;
    candidateIndex -= 1;
    candidate = record(input[candidateIndex]);
  }
  if (inputItemType(candidate) !== "message" || candidate?.role !== "user"
    || typeof candidate.id !== "string" || !candidate.id) return undefined;
  const candidateTurnId = itemTurnId(candidate);
  if (candidateTurnId !== undefined && candidateTurnId !== metadataTurnId) return undefined;

  const content = Array.isArray(candidate.content) ? candidate.content : [];
  for (const part of content) {
    const text = record(part)?.text;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (!/^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed)) continue;
    // Current Codex stamps server-owned item IDs but not per-item turn IDs on the initial request,
    // and canonical workspaces contains Git enrichment rather than filesystem authority. Bind the
    // structurally adjacent context (allowing only provenance-checked developer messages) to
    // canonical turn/sandbox metadata; when Git roots are present, require the primary cwd to agree
    // with them as an additional check.
    if (!environmentMatchesCanonicalMetadata(trimmed, metadata, requireMetadataBoundRoots)) continue;
    return trimmed;
  }
  return undefined;
}

function hasAssistantOutputBetween(input: unknown[], startIndex: number, endIndex: number): boolean {
  for (let index = startIndex; index < endIndex; index += 1) {
    const item = record(input[index]);
    if (!item) continue;
    if (inputItemType(item) === "message" && item.role === "assistant") return true;
    if (item.type === "function_call" || item.type === "reasoning") return true;
  }
  return false;
}

function rawEnvironmentText(parsed: CodexParsedRequest): string | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  let activeUserIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (isNativeInstruction(item, metadata)) {
      activeUserIndex = index;
      break;
    }
  }
  const checkpoint = activeUserIndex < 0 ? recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed)) : undefined;
  const anchorIndex = checkpoint?.summaryIndex ?? activeUserIndex;
  const turnId = metadata?.turn_id;
  // A mid-turn update supersedes the start envelope too. Do not return that earlier authority
  // before the store can authenticate the delta against the current native turn context.
  if (input.slice(anchorIndex + 1).some(value => {
    const item = record(value);
    return hasEnvironmentContextFragment(item)
      && (itemTurnId(item) === undefined || itemTurnId(item) === turnId);
  })) return undefined;
  const currentByTurn = environmentBeforeUser(
    input,
    activeUserIndex,
    typeof turnId === "string" ? turnId : undefined,
    metadata,
  );
  if (currentByTurn) return currentByTurn;

  const current = checkpoint && metadata
    ? canonicalMetadataEnvironmentBefore(input, checkpoint.summaryIndex, metadata)
    : canonicalMetadataEnvironmentBeforeUser(input, activeUserIndex, metadata);
  if (current) return current;

  // A skill invocation appends another server-owned user item after the real instruction. Recover
  // the earlier current-turn environment/prompt pair only through canonical metadata, and bind all
  // declared roots to metadata workspaces so user-authored XML cannot widen filesystem authority.
  let crossedAssistantOutput = false;
  for (let index = activeUserIndex - 1; index > 0; index -= 1) {
    crossedAssistantOutput ||= hasAssistantOutputBetween(input, index, index + 1);
    // Replayed untagged history is not a same-turn skill invocation. Only explicit current-turn
    // provenance may cross an assistant response; otherwise resolve from the native rollout.
    if (crossedAssistantOutput && itemTurnId(input[index]) !== turnId) continue;
    const sameTurn = canonicalMetadataEnvironmentBeforeUser(input, index, metadata, true);
    if (sameTurn) return sameTurn;
  }

  // An attempted current update takes precedence over all older authority, even when its native
  // item metadata is incomplete. Never mask malformed permissions/cwd with a previous turn.
  if (hasCurrentChatGptEnvironmentContext(parsed)) return undefined;

  const replayPrefixLen = Math.min(parsed._replayPrefixLen ?? 0, input.length);
  for (let index = replayPrefixLen - 1; index > 0; index -= 1) {
    const replayed = environmentBeforeUser(input, index, undefined, metadata);
    if (replayed) return replayed;
  }

  // Codex can resume a local task by explicitly replaying its native transcript instead of
  // sending previous_response_id. In that shape, accept a historical environment/user pair only
  // when both items carry the same native turn_id and either completed assistant output separates
  // that turn from the active user or the complete historical pair is server-owned and its
  // filesystem authority still matches the current thread's canonical workspace/sandbox metadata.
  // A user-authored <environment_context> inside one chat message cannot satisfy this structure.
  const currentTurnId = typeof turnId === "string" ? turnId : undefined;
  const currentThreadId = typeof metadata?.thread_id === "string" && metadata.thread_id.trim()
    ? metadata.thread_id
    : undefined;
  const activeUser = record(input[activeUserIndex]);
  const activeUserOwned = isNativeInstruction(activeUser, metadata)
    && typeof activeUser.id === "string"
    && activeUser.id.length > 0
    && itemTurnId(activeUser) === currentTurnId;
  if (currentTurnId && itemTurnId(activeUser) === currentTurnId) {
    for (let index = activeUserIndex - 1; index > 0; index -= 1) {
      const historicalUser = record(input[index]);
      const historicalTurnId = itemTurnId(historicalUser);
      if (!historicalTurnId || historicalTurnId === currentTurnId) continue;
      const historical = environmentBeforeUser(input, index, undefined, metadata);
      if (!historical) continue;
      if (hasAssistantOutputBetween(input, index + 1, activeUserIndex)) return historical;
      if (!currentThreadId || !metadata || !activeUserOwned) continue;
      const bounded = canonicalMetadataEnvironmentBeforeUser(
        input,
        index,
        { ...metadata, turn_id: historicalTurnId, sandbox: canonicalSandboxMetadata(metadata) },
        true,
      );
      if (bounded === historical) return bounded;
    }
  }
  return undefined;
}

function clientMetadataWorkspaceRoots(parsed: CodexParsedRequest): string[] {
  const workspaces = record(clientTurnMetadata(parsed)?.workspaces);
  if (!workspaces) return [];
  const roots = Object.keys(workspaces);
  if (roots.some(path => !isAbsolute(path))) return [];
  return [...new Set(roots.map(pathIdentity))];
}

function trustedEnvironmentText(parsed: CodexParsedRequest): string {
  const raw = rawEnvironmentText(parsed);
  if (raw) return raw;
  // A real Responses request always has `_rawBody`. Parsed system/developer text has already lost
  // the wire provenance needed to distinguish Codex context from user-authored XML, so it must
  // never become filesystem authority for a raw request.
  if (parsed._rawBody !== undefined) return "";
  const system = parsed.context.systemPrompt ?? [];
  const developer = parsed.context.messages
    .filter(message => message.role === "developer")
    .map(message => contentText(message.content));
  return [...system, ...developer].join("\n");
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function environmentCwdMatches(text: string, preferredRoots: string[] = []): string[] {
  const sections = [...text.matchAll(/<environments>([\s\S]*?)<\/environments>/gi)];
  if (sections.length === 0) {
    const cwdMatches = [...text.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map(match => match[1] ?? "");
    if (cwdMatches.length > 0 || /<\/?cwd\b/i.test(text)) return cwdMatches;

    // Codex Desktop 0.150+ can emit a filesystem-only environment diff when an existing task is
    // rebound to another model. Its ordered multi-folder contract uses the first workspace root as
    // the task's working directory and the remaining roots as additional filesystem authority.
    // Recover only that exact cwd-less shape; malformed cwd markup and multi-environment payloads
    // continue to fail closed.
    const rootSections = [...text.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/gi)];
    if (rootSections.length !== 1) return [];
    const rootSection = rootSections[0]![0];
    const roots = [...rootSection.matchAll(/<root>([^<]+)<\/root>/gi)]
      .map(match => match[1] ?? "");
    const rootOpenings = [...rootSection.matchAll(/<root\b[^>]*>/gi)];
    const rootClosings = [...rootSection.matchAll(/<\/root\s*>/gi)];
    if (rootOpenings.length !== roots.length || rootClosings.length !== roots.length) return [];
    return roots.length > 0 ? [roots[0]!] : [];
  }
  if (sections.length !== 1) return [];

  const section = sections[0]!;
  const outside = text.replace(section[0], "");
  if (/<cwd>[^<]*<\/cwd>/i.test(outside)) return [];

  const environments = [...section[1]!.matchAll(/<environment\b([^>]*)>([\s\S]*?)<\/environment>/gi)];
  const primary = environments.filter(match => /\bprimary\s*=\s*["']true["']/i.test(match[1] ?? ""));
  if (primary.length === 1) {
    return [...primary[0]![2]!.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map(match => match[1] ?? "");
  }
  if (primary.length > 1) return [];

  // Codex 0.146.x emitted multiple environments without a primary attribute. Only use that
  // legacy shape when canonical workspace metadata identifies one candidate; never pick by order.
  const candidates = environments.flatMap(environment => {
    const cwdMatches = [...environment[2]!.matchAll(/<cwd>([^<]+)<\/cwd>/gi)]
      .map(match => match[1] ?? "");
    return cwdMatches.length === 1 ? cwdMatches : [];
  });
  if (candidates.length === 1) return candidates;
  if (preferredRoots.length === 0) return [];

  const exact = candidates.filter(candidate => preferredRoots
    .some(root => pathIdentity(root) === pathIdentity(candidate)));
  if (exact.length === 1) return exact;
  const contained = candidates.filter(candidate => preferredRoots
    .some(root => matchesPath(root, candidate)));
  return contained.length === 1 ? contained : [];
}

function uniqueAbsolutePaths(values: string[], field: string): string[] {
  const decoded = values.map(value => decodeXmlText(value.trim()));
  if (decoded.length === 0) throw new MissingTrustedCodexEnvironmentError(field);
  if (decoded.some(path => !isAbsolute(path))) {
    throw new TrustedCodexEnvironmentValidationError(`ChatGPT web ${field} must contain absolute paths`);
  }
  const unique = new Map<string, string>();
  for (const path of decoded.map(value => resolve(value))) {
    if (!unique.has(pathIdentity(path))) unique.set(pathIdentity(path), path);
  }
  return [...unique.values()];
}

function matchesPath(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function extractChatGptTurnEnvironment(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
  return parseChatGptEnvironmentText(parsed, trustedEnvironmentText(parsed));
}

export function extractChatGptDelegatedTurnCapability(
  parsed: CodexParsedRequest,
): ChatGptDelegatedTurnCapability {
  const identity = extractChatGptTurnIdentity(parsed);
  const threadId = identity.threadId?.trim();
  const turnId = identity.turnId?.trim();
  if (!threadId || !turnId) {
    throw new ChatGptWebAdapterError(
      "Delegated ChatGPT tool authority requires native Codex thread_id and turn_id metadata",
      {
        status: 400,
        errorType: "invalid_request_error",
        code: "missing_delegated_turn_identity",
        retryable: false,
      },
    );
  }
  return {
    authorityMode: "delegated",
    threadId,
    turnId,
    tools: structuredClone(parsed.context.tools ?? []),
  };
}

function parseChatGptEnvironmentText(parsed: CodexParsedRequest, text: string): ChatGptTurnEnvironment {
  const cwdMatches = environmentCwdMatches(text, clientMetadataWorkspaceRoots(parsed));
  const cwdCandidates = uniqueAbsolutePaths(cwdMatches, "cwd");
  if (cwdCandidates.length !== 1) {
    throw new TrustedCodexEnvironmentValidationError("ChatGPT web turn has conflicting trusted Codex cwd values");
  }
  const cwd = cwdCandidates[0]!;

  const rootMatches = [...text.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/g)]
    .flatMap(section => [...section[0].matchAll(/<root>([^<]+)<\/root>/g)].map(match => match[1] ?? ""));
  const roots = rootMatches.length > 0 ? uniqueAbsolutePaths(rootMatches, "workspace_roots") : [cwd];
  if (!roots.some(root => matchesPath(root, cwd))) {
    throw new TrustedCodexEnvironmentValidationError("ChatGPT web cwd is outside the trusted Codex workspace roots");
  }

  const sandboxType = sandboxTypeFromEnvironment(text);
  const networkAccess = /<network_access>enabled<\/network_access>/i.test(text)
    || /network access is enabled/i.test(text);

  if (!sandboxType) {
    throw new TrustedCodexEnvironmentValidationError("ChatGPT web turn requires one explicit trusted Codex sandbox mode");
  }
  if (sandboxType === "dangerFullAccess") {
    return { cwd, roots, writableRoots: roots, sandboxPolicy: { type: "dangerFullAccess" }, tools: parsed.context.tools ?? [] };
  }
  if (sandboxType === "workspaceWrite") {
    return {
      cwd,
      roots,
      writableRoots: roots,
      sandboxPolicy: { type: "workspaceWrite", writableRoots: roots, networkAccess },
      tools: parsed.context.tools ?? [],
    };
  }
  return { cwd, roots, writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess }, tools: parsed.context.tools ?? [] };
}

export function extractChatGptTurnIdentity(parsed: CodexParsedRequest): ChatGptTurnIdentity {
  const body = record(parsed._rawBody);
  return {
    ...extractCodexTurnIdentityFromBody(body),
    ...(typeof body?.prompt_cache_key === "string" ? { promptCacheKey: body.prompt_cache_key } : {}),
  };
}

/** Read only Codex-owned lifecycle identity without interpreting or rewriting the provider body. */
export function extractCodexTurnIdentityFromBody(value: unknown): ChatGptTurnIdentity {
  const metadata = clientTurnMetadataFromBody(value);
  return {
    ...(typeof metadata?.thread_id === "string" ? { threadId: metadata.thread_id } : {}),
    ...(typeof metadata?.turn_id === "string" ? { turnId: metadata.turn_id } : {}),
    ...(typeof metadata?.parent_thread_id === "string" ? { parentThreadId: metadata.parent_thread_id } : {}),
    ...(typeof metadata?.agent_name === "string" ? { agentName: metadata.agent_name } : {}),
    ...(typeof metadata?.subagent_kind === "string" ? { subagentKind: metadata.subagent_kind } : {}),
  };
}

/**
 * Return the canonical parent link carried by a native Codex thread-spawn request.
 * This is deliberately stricter than generic metadata parsing: only a real child turn with an
 * agent name, explicit turn purpose, sandbox policy, and absolute workspace evidence can inherit
 * filesystem authority from a previously verified parent thread.
 */
export function extractChatGptThreadSpawnLineage(
  parsed: CodexParsedRequest,
): ChatGptThreadSpawnLineage | undefined {
  const metadata = clientTurnMetadata(parsed);
  if (!metadata || !isEnvironmentRequest(metadata, parsed) || metadata.subagent_kind !== "thread_spawn") return undefined;
  const threadId = typeof metadata.thread_id === "string" ? metadata.thread_id.trim() : "";
  const parentThreadId = typeof metadata.parent_thread_id === "string" ? metadata.parent_thread_id.trim() : "";
  const agentName = typeof metadata.agent_name === "string" ? metadata.agent_name.trim() : "";
  if (!threadId || !parentThreadId || threadId === parentThreadId
    || (agentName !== "/root" && !/^\/root\/.+/.test(agentName))) return undefined;

  const sandboxType = sandboxTypeFromMetadata(canonicalSandboxMetadata(metadata));
  if (!sandboxType || sandboxType === "platform") return undefined;
  const workspaces = record(metadata.workspaces);
  const workspacePaths = workspaces ? Object.keys(workspaces) : [];
  if (workspacePaths.some(path => !isAbsolute(path))) return undefined;
  const workspaceRoots = [...new Set(workspacePaths.map(path => resolve(path)))];
  return { threadId, parentThreadId, agentName, sandboxType, workspaceRoots };
}

/** Root tasks have no spawn edge; their canonical session and current turn must prove authority. */
export function extractChatGptRootThreadMetadata(parsed: CodexParsedRequest): ChatGptRootThreadMetadata | undefined {
  const metadata = clientTurnMetadata(parsed);
  if (!metadata || !isEnvironmentRequest(metadata, parsed)
    || metadata.parent_thread_id != null || metadata.subagent_kind != null
    || (metadata.agent_name != null && metadata.agent_name !== "/root")) return undefined;
  const threadId = typeof metadata.thread_id === "string" ? metadata.thread_id.trim() : "";
  const sandboxType = sandboxTypeFromMetadata(canonicalSandboxMetadata(metadata));
  const workspaces = record(metadata.workspaces);
  const workspacePaths = workspaces ? Object.keys(workspaces) : [];
  if (!threadId || !sandboxType || workspacePaths.some(path => !isAbsolute(path))) return undefined;
  return { threadId, sandboxType, workspaceRoots: [...new Set(workspacePaths.map(path => resolve(path)))] };
}

function isEnvironmentRequest(metadata: Record<string, unknown>, parsed: CodexParsedRequest): boolean {
  return metadata.request_kind === "turn"
    || (parsed._compactionRequest === true && metadata.request_kind === "compaction");
}
