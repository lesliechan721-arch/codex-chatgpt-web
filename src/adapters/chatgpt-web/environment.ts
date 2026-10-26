import {
  record, inputItemType, clientTurnMetadataFromBody, clientTurnMetadata, itemTurnId, rawMessageText,
  hasEnvironmentContextFragment, contextualUserMessage, isNativeOpenPageContext, isDelegatedInstruction,
  isNativeInstruction, isTurnAbortedNotice, continuityInstructionSelection, userRevision,
  requestCarriedChatGptInstructionRevision, chatGptInstructionEnvelope, hasNativeChatGptInstruction,
  type ChatGptTurnUserRevision,
} from "./environment-instruction";
export { requestCarriedChatGptInstructionRevision, chatGptInstructionEnvelope, hasNativeChatGptInstruction } from "./environment-instruction";
export type { ChatGptTurnUserRevision } from "./environment-instruction";

import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildCompactV1Output, decodeCompactionSummary, extractCompactUserMessages, isReadableCompactionSummaryText, OPAQUE_COMPACTION_NOTE } from "../../responses/compaction";
import { isNativeAgentsMdContext } from "../../responses/native-context";
import type { CodexContentPart, CodexParsedRequest, CodexTool } from "../../types";
import { hasCompactionEnvironmentCheckpoint, isAcceptedCompactionContinuation, recoverCompactionInstruction } from "./compaction-continuation";
import { ChatGptWebAdapterError } from "./adapter-error";
import { continuityError } from "./continuity-errors";
import { canonicalJson } from "./canonical-json";
import { bindContextEnvironmentInputSource, bindContextInstructionInputSource } from "./context-candidate-mapping";

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

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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

/** Codex supplies this lifecycle marker on its ephemeral composer-prediction turn. */
export function isCodexComposerPrediction(value: unknown): boolean {
  const metadata = clientTurnMetadataFromBody(value);
  return metadata?.request_kind === "turn" && metadata.turn_trigger === "composer_predictions";
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
  /** Optional wire constraints; only a matching native record can prove either value. */
  turnId?: string;
  contentItemKinds?: unknown;
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

/** A native text compact must prove every carried environment, including attributed history. */
export function nativeChatGptCompactionEnvironmentMessages(parsed: CodexParsedRequest): {
  current?: ChatGptUnattributedEnvironmentMessage;
  historical: ChatGptUnattributedEnvironmentMessage[];
} {
  const input = record(parsed._rawBody)?.input;
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const current: ChatGptUnattributedEnvironmentMessage[] = [];
  const historical: ChatGptUnattributedEnvironmentMessage[] = [];
  const ids = new Set<string>();
  for (const value of Array.isArray(input) ? input : []) {
    const item = record(value);
    if (!hasEnvironmentContextFragment(item)) continue;
    if (typeof item.id !== "string" || !item.id) {
      throw new TrustedCodexEnvironmentValidationError("Native compaction environment has no source message id");
    }
    if (ids.has(item.id)) throw new TrustedCodexEnvironmentValidationError("Codex environment history repeats a message id");
    ids.add(item.id);
    const provenance = record(item.internal_chat_message_metadata_passthrough);
    const message = { id: item.id, content: item.content,
      ...(itemTurnId(item) ? { turnId: itemTurnId(item) } : {}),
      ...(provenance?.content_item_kinds !== undefined ? { contentItemKinds: provenance.content_item_kinds } : {}),
    };
    (itemTurnId(item) === turnId ? current : historical).push(message);
  }
  if (current.length > 1) throw new TrustedCodexEnvironmentValidationError("Native compaction repeats the current environment");
  return { ...(current[0] ? { current: current[0] } : {}), historical };
}

function compactionSummaryMessage(value: Record<string, unknown>): boolean {
  if (value.type !== "message" || value.role !== "user") return false;
  const text = rawMessageText(value).trim();
  return isReadableCompactionSummaryText(text) || text === OPAQUE_COMPACTION_NOTE;
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

function latestChatGptTurnUserRevision(parsed: CodexParsedRequest, expectedTurnId?: string, recoverCheckpoint = true): ChatGptTurnUserRevision | undefined {
  const carried = requestCarriedChatGptInstructionRevision(parsed, expectedTurnId);
  const identity = extractChatGptTurnIdentity(parsed);
  const recovered = recoverCheckpoint ? recoverCompactionInstruction(parsed, identity) : undefined;
  if (!carried) return recovered?.source;
  if (!recovered?.sourceWasSyntheticInstruction) return carried;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  const index = continuityInstructionSelection(parsed, input)?.carried.get(expectedTurnId)
    ?? input.findLastIndex(value => userRevision(value, expectedTurnId, metadata) !== undefined);
  // The v1 producer drops synthetic delegation while retaining an older human message.
  // Only its exact committed representation before the summary can stand for that source.
  return index < recovered.summaryIndex && isAcceptedCompactionContinuation(parsed, identity, carried)
    ? recovered.source : carried;
}

export interface ChatGptNativeInstructionOwnership {
  itemId: string;
  turnId: string;
  contentDigest: string;
}

interface BoundNativeInstructionOwnership {
  proof: ChatGptNativeInstructionOwnership;
  body: unknown;
  input: unknown[];
  item: unknown;
  index: number;
  digest: string;
  scope?: string;
  threadId?: string;
}

const nativeInstructionOwnership = new WeakMap<CodexParsedRequest, BoundNativeInstructionOwnership>();
const instructionContentDigest = (content: unknown): string => createHash("sha256").update(canonicalJson(content)).digest("hex");

/** Only the trusted rollout resolver may publish ownership; wire metadata stays unchanged. */
export function bindNativeInstructionOwnership(parsed: CodexParsedRequest,
  proof?: ChatGptNativeInstructionOwnership): void {
  nativeInstructionOwnership.delete(parsed);
  const input = record(parsed._rawBody)?.input;
  if (Array.isArray(input)) continuityInstructionSelection(parsed, input)?.inputs.clear();
  if (!proof) return;
  const index = chatGptCurrentInstructionIndex(parsed), item = Array.isArray(input) ? record(input[index]) : undefined;
  const identity = extractChatGptTurnIdentity(parsed);
  if (parsed._conversationPolicy !== "task" || parsed._compactionRequest || !Array.isArray(input) || !item
    || inputItemType(item) !== "message" || item.role !== "user" || item.id !== proof.itemId
    || identity.turnId !== proof.turnId || (itemTurnId(item) !== undefined && itemTurnId(item) !== proof.turnId)
    || instructionContentDigest(item.content) !== proof.contentDigest) throw continuityError("continuity_source_unproven");
  nativeInstructionOwnership.set(parsed, { proof: { ...proof }, body: parsed._rawBody, input, item, index,
    digest: instructionContentDigest(input), scope: parsed._continuityScope, threadId: identity.threadId });
}

function currentNativeInstructionOwnership(parsed: CodexParsedRequest, input: unknown[]): BoundNativeInstructionOwnership | undefined {
  const bound = nativeInstructionOwnership.get(parsed);
  if (!bound) return undefined;
  const identity = extractChatGptTurnIdentity(parsed);
  if (parsed._conversationPolicy !== "task" || parsed._compactionRequest || bound.body !== parsed._rawBody
    || bound.input !== input || bound.item !== input[bound.index] || bound.digest !== instructionContentDigest(input)
    || bound.scope !== parsed._continuityScope || bound.threadId !== identity.threadId || bound.proof.turnId !== identity.turnId) {
    throw continuityError("continuity_source_unproven", "The authenticated current instruction input changed after native verification.");
  }
  return bound;
}

const durableQueuedInstructionSelections = new WeakMap<CodexParsedRequest, { input: unknown[]; digest: string; scope?: string; indices: number[] }>();

/** Only the current checkpoint's durable inbox proof may establish this boundary. */
export function bindDurableQueuedInstructionInput(parsed: CodexParsedRequest, indices: number[]): void {
  const input = record(parsed._rawBody)?.input;
  if (!Array.isArray(input) || !indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= input.length)) {
    throw continuityError("continuity_source_unproven");
  }
  durableQueuedInstructionSelections.set(parsed, { input, digest: canonicalJson(input), scope: parsed._continuityScope, indices: [...indices] });
}

/** Index of the latest native instruction that is physically present in this request. */
export function chatGptCurrentInstructionIndex(parsed: CodexParsedRequest): number {
  if (parsed._continuityRequestInstruction) return -1;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const identity = extractChatGptTurnIdentity(parsed);
  if (parsed._compactionRequest) {
    identity.turnId = extractChatGptCompactionSourceRevision(parsed).turnId
      ?? parsed._chatGptCompactionSourceTurnId ?? identity.turnId;
  }
  const metadata = clientTurnMetadata(parsed);
  const checkpoint = parsed._conversationPolicy === "task" && !parsed._compactionRequest
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
      && parsed._conversationPolicy === "task" && !parsed._compactionRequest
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
  if (parsed._continuityRequestInstruction) return parsed._continuityRequestInstruction;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const index = chatGptCurrentInstructionIndex(parsed);
  return index >= 0 ? userRevision(input[index], undefined, clientTurnMetadata(parsed), true)
    : recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed))?.source;
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

/** Fixed, domain-separated proof of one accepted instruction representation. */
export function continuityCheckpointSiblingProof(parsed: CodexParsedRequest, value: unknown) {
  const item = record(value);
  if (!item) return undefined;
  const id = typeof item.id === "string" ? parsed._chatGptMessageIdAliases?.[item.id] ?? item.id : undefined;
  const normalized = { ...item, content: chatGptInstructionContent(item), ...(id ? { id } : {}) };
  const hash = (domain: string, value: unknown) => createHash("sha256").update(canonicalJson([domain, value])).digest("hex");
  return { identity: id ? hash("continuity-checkpoint-sibling-id-v1", id) : undefined,
    representation: hash("continuity-checkpoint-sibling-value-v1", normalized) };
}

export function continuityCheckpointSiblingGroup(proofs: readonly { representation: string }[]): string {
  return createHash("sha256").update(canonicalJson(["continuity-checkpoint-sibling-group-v1", proofs.map(proof => proof.representation)])).digest("hex");
}

export const CONTINUITY_CHECKPOINT_SIBLING_PROOF = createHash("sha256")
  .update(canonicalJson(["continuity-checkpoint-sibling-proof-v1"])).digest("hex");

/** Reuse the source work's accepted predecessor boundary, not its full old history. */
export function continuityCheckpointSiblings(parsed: CodexParsedRequest,
  previous?: { instructionIdentity?: string; nativeTurnId?: string; trustedLowerBound?: number }, sourceIndex = chatGptCurrentInstructionIndex(parsed)) {
  const input = record(parsed._rawBody)?.input;
  if (!Array.isArray(input) || sourceIndex < 0) return [];
  if (!input.slice(0, sourceIndex).some(value => {
    const item = record(value);
    return item && (inputItemType(item) === "message" || item.type === "agent_message" || isDelegatedInstruction(item));
  })) return [];
  const selected = continuityCurrentInstructionInput(parsed, previous, true, sourceIndex);
  let cursor = 0;
  return selected.flatMap(value => {
    const encoded = canonicalJson(value);
    const index = input.findIndex((item, position) => position >= cursor && canonicalJson(item) === encoded);
    if (index < 0) throw continuityError("continuity_source_unproven");
    cursor = index + 1;
    // Current system/developer and environment constraints can be rebuilt by the
    // client. Their first-consumer payload is checked by the continuation path;
    // this proof binds the source work's native task instructions only.
    if (!hasNativeChatGptInstruction(parsed, [value])) return [];
    return index < sourceIndex ? [{ ...continuityCheckpointSiblingProof(parsed, value)!, index, value }] : [];
  });
}

/** Publish only after the exact durable checkpoint proved its carried sibling group. */
export function bindContinuityCheckpointSourceIndex(parsed: CodexParsedRequest, index: number): void {
  const input = record(parsed._rawBody)?.input;
  if (!Array.isArray(input) || index < 0 || index >= input.length) throw continuityError("continuity_source_unproven");
  const selected = continuityInstructionSelection(parsed, input);
  if (selected) { selected.index = index; selected.inputs.clear(); }
}

/** Reintroduce all native instruction items belonging to the current incremental work. */
export function continuityCurrentInstructionInput(
  parsed: CodexParsedRequest,
  previous?: { instructionIdentity?: string; nativeTurnId?: string; trustedLowerBound?: number; rejectExecutionOutput?: boolean },
  includeRetainedSource = false,
  sourceInstructionIndex?: number,
): unknown[] {
  if (parsed._continuityRequestInstruction) {
    const source = parsed._continuityRequestInstruction;
    return [{ type: "message", ...source.instructionEnvelope, id: source.itemId, content: source.content,
      internal_chat_message_metadata_passthrough: { turn_id: source.turnId } }];
  }
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const index = sourceInstructionIndex ?? chatGptCurrentInstructionIndex(parsed);
  const ownership = currentNativeInstructionOwnership(parsed, input);
  const owner = (candidate: number): string | undefined => itemTurnId(input[candidate])
    ?? (ownership?.index === candidate ? ownership.proof.turnId : undefined);
  const identity = extractChatGptTurnIdentity(parsed);
  if (parsed._compactionRequest) {
    identity.turnId = extractChatGptCompactionSourceRevision(parsed).turnId
      ?? parsed._chatGptCompactionSourceTurnId ?? identity.turnId;
  }
  const prior = previous;
  const checkpointIndex = prior?.trustedLowerBound;
  // Native ownership authenticates this new human, not tool results carried across the
  // checkpoint. Later results for the accepted current turn retain their normal replay path.
  if (prior?.rejectExecutionOutput && ownership?.index === index && checkpointIndex !== undefined && checkpointIndex >= 0
    && prior?.nativeTurnId !== undefined && prior.nativeTurnId !== identity.turnId
    && input.slice(checkpointIndex + 1).some(value => {
      const item = record(value);
      return item?.role === "assistant" || ["function_call", "custom_tool_call", "function_call_output",
        "custom_tool_call_output", "tool_search_call", "tool_search_output", "compaction"].includes(String(item?.type));
    })) throw continuityError("continuity_source_unproven", "Native instruction ownership cannot authenticate checkpoint execution output.");
  const selection = continuityInstructionSelection(parsed, input);
  const selectionKey = JSON.stringify([previous?.instructionIdentity ?? null, previous?.nativeTurnId ?? null,
    previous?.trustedLowerBound ?? null, previous?.rejectExecutionOutput === true, sourceInstructionIndex ?? null, includeRetainedSource]);
  const cached = selection?.inputs.get(selectionKey);
  const clone = (candidate: number): unknown => {
    const item = structuredClone(input[candidate]);
    bindContextInstructionInputSource(parsed, item, candidate, isDelegatedInstruction(record(input[candidate])));
    return item;
  };
  if (cached) return cached.map(clone);
  const remember = (indices: number[]): unknown[] => {
    selection?.inputs.set(selectionKey, indices);
    return indices.map(clone);
  };
  const queued = durableQueuedInstructionSelections.get(parsed);
  if (queued && queued.input === input && queued.scope === parsed._continuityScope && queued.digest === canonicalJson(input)) {
    return remember(queued.indices);
  }
  const retainCurrentSource = includeRetainedSource && isRetainedCompactionSourceInstruction(parsed, input[index]);
  const metadata = clientTurnMetadata(parsed);
  const currentTurnOwned = owner(index) === identity.turnId;
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
  const prefixStarts = [0, ...(checkpointIndex !== undefined && checkpointIndex >= 0 ? [checkpointIndex + 1] : [])];
  for (const start of prefixStarts) {
    for (let candidate = start; candidate < input.length; candidate += 1) {
      const item = record(input[candidate]);
      if (item?.type === "additional_tools") continue;
      const envelope = inputItemType(item) === "message" && (item?.role === "system" || item?.role === "developer");
      const grouped = (hasEnvironmentContextFragment(item) && Array.isArray(item.content))
        || Boolean(item && isNativeAgentsMdContext(item));
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
  const currentId = record(input[index])?.id;
  const currentInstructionId = typeof currentId === "string" ? parsed._chatGptMessageIdAliases?.[currentId] ?? currentId
    : itemTurnId(input[index]) ? `turn:${itemTurnId(input[index])}` : undefined;
  if (prior?.instructionIdentity && currentInstructionId === prior.instructionIdentity
    && isRetainedCompactionSourceInstruction(parsed, input[index])) {
    lowerBound = Math.max(lowerBound, index);
  }
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
  for (let candidate = 0; candidate < (sourceInstructionIndex === undefined ? input.length : index + 1); candidate += 1) {
    const item = input[candidate];
    const message = record(item);
    const revision = userRevision(item, identity.turnId, metadata);
    const envelope = inputItemType(message) === "message"
      && (message?.role === "system" || message?.role === "developer");
    const grouped = Boolean(message && currentEnvironmentItems.has(message) && Array.isArray(message.content)
      && (chatGptInstructionContent(message) as unknown[]).length > 0);
    const supplemental = envelope || grouped || Boolean(message && isNativeAgentsMdContext(message));
    const nativeTurnId = revision?.turnId ?? owner(candidate);
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
  const currentIndex = parsed._conversationPolicy === "task"
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
  return currentChatGptEnvironmentParts(parsed).filter(part => !selected.has(canonicalJson(part.item))).map(part => {
    const item = {
      ...part.item,
      content: [{ type: "input_text", text: part.text }],
      internal_chat_message_metadata_passthrough: {
        ...record(part.item.internal_chat_message_metadata_passthrough),
        content_item_kinds: ["environments.environment_context"],
      },
    };
    bindContextEnvironmentInputSource(parsed, item);
    return item;
  });
}

/** A retained source copied by the checkpoint codec is not a new instruction to execute. */
export function isRetainedCompactionSourceInstruction(parsed: CodexParsedRequest, value: unknown): boolean {
  const identity = extractChatGptTurnIdentity(parsed);
  const revision = userRevision(value, identity.turnId, clientTurnMetadata(parsed), parsed._conversationPolicy === "task");
  const accepted = recoverCompactionInstruction(parsed, identity);
  return Boolean(revision && accepted
    && (!revision.itemId || !accepted.source.itemId
      || (parsed._chatGptMessageIdAliases?.[revision.itemId] ?? revision.itemId)
        === (parsed._chatGptMessageIdAliases?.[accepted.source.itemId] ?? accepted.source.itemId))
    && isAcceptedCompactionContinuation(parsed, identity, revision));
}

/** Canonical instruction order distinguishes new steering from a delayed older request. */
export function chatGptTurnUserRevisionHistory(parsed: CodexParsedRequest): ChatGptTurnUserRevision[] {
  if (parsed._continuityRequestInstruction) return [parsed._continuityRequestInstruction];
  const body = record(parsed._rawBody);
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const metadata = clientTurnMetadata(parsed);
  const identity = extractChatGptTurnIdentity(parsed);
  const recovered = recoverCompactionInstruction(parsed, identity);
  const input = Array.isArray(body?.input) ? body.input : [];
  const includeEnvelope = parsed._conversationPolicy === "task";
  const prefix = recovered?.sourceWasSyntheticInstruction ? input.slice(0, recovered.summaryIndex) : [];
  const retained = prefix.map(value => userRevision(value, turnId, metadata, includeEnvelope)).filter(value => value !== undefined).at(-1);
  const recoverSyntheticInstruction = recovered?.sourceWasSyntheticInstruction && (!retained
    || isAcceptedCompactionContinuation(parsed, identity, retained));
  const revisions = input.slice(recoverSyntheticInstruction ? recovered!.summaryIndex + 1 : 0).flatMap(value => {
    const revision = userRevision(value, turnId, metadata, includeEnvelope);
    return revision ? [revision] : [];
  });
  if (recoverSyntheticInstruction) return [recovered!.source, ...revisions];
  return revisions.length > 0 ? revisions : recovered ? [recovered.source] : [];
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
export function extractChatGptCompactionSourceRevision(
  parsed: CodexParsedRequest,
  options: { recoverCheckpoint?: boolean } = {},
): ChatGptTurnUserRevision {
  const revision = findChatGptCompactionSourceRevision(parsed, options);
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
    const source = userRevision(input[index], identity.turnId, metadata, parsed._conversationPolicy === "task");
    if (source) return source;
  }
  return extractChatGptCompactionSourceRevision(parsed);
}

/** A retained representation can have context but no instruction; it adds no source alias. */
export function findChatGptCompactionSourceRevision(
  parsed: CodexParsedRequest,
  options: { recoverCheckpoint?: boolean } = {},
): ChatGptTurnUserRevision | undefined {
  if (!parsed._compactionRequest) throw new Error("ChatGPT web compaction source requires a compaction request");
  return latestChatGptTurnUserRevision(parsed, extractChatGptTurnIdentity(parsed).turnId, options.recoverCheckpoint !== false);
}

/** A completed checkpoint identifies the current turn's rebuilt environment preamble. */
export function isChatGptCompactionContinuation(parsed: CodexParsedRequest): boolean {
  const identity = extractChatGptTurnIdentity(parsed);
  const revision = latestChatGptTurnUserRevision(parsed, identity.turnId);
  return revision?.turnId !== undefined && identity.turnId !== undefined
    && !priorChatGptAbortedTurnIds(parsed).includes(revision.turnId)
    // Pre-turn compaction can append the new instruction after the checkpoint. It still
    // rebuilds the preamble before the retained older instruction; the store must validate
    // that claim against the current native rollout just as for an older-source continuation.
    && (revision.turnId === identity.turnId
      ? hasCompactionEnvironmentCheckpoint(parsed, identity)
      : isAcceptedCompactionContinuation(parsed, identity, revision));
}

export interface ChatGptCalendarEnvironmentDelta {
  workspaceRoots: string[][];
  filesystemProfiles: string[];
}

export interface ChatGptEnvironmentClaim {
  /** Filesystem roots require native confirmation before they can identify cwd. */
  environment: Omit<ChatGptTurnEnvironment, "cwd"> & { cwd?: string };
  /** Exact request message selected by the environment parser; native provenance is still unproven. */
  sourceMessage?: ChatGptUnattributedEnvironmentMessage;
  /**
   * Codex's permission-profile envelope states filesystem access only; the network policy lives
   * in the native turn context. Only the legacy sandbox_mode envelope carried a network statement.
   */
  statesNetworkAccess: boolean;
  /** Later calendar fragments remain claims until the current rollout corroborates them. */
  calendarDelta?: ChatGptCalendarEnvironmentDelta;
}

export type ChatGptNativeCompactionPhase = "pre_turn" | "mid_turn" | "post_turn" | "standalone_turn";

/** Only the recognized native text protocol can borrow a retained checkpoint's permission turn. */
export function extractChatGptNativeCompactionPhase(parsed: CodexParsedRequest): ChatGptNativeCompactionPhase | undefined {
  if (!parsed._compactionRequest) return undefined;
  const metadata = clientTurnMetadata(parsed);
  const protocol = record(metadata?.compaction);
  if (metadata?.request_kind !== "compaction" || protocol?.implementation !== "responses"
    || protocol.strategy !== "memento") return undefined;
  const phase = protocol.phase;
  if (phase === "pre_turn" || phase === "mid_turn" || phase === "post_turn" || phase === "standalone_turn") return phase;
  // Declaring this native protocol requires its phase. Unknown/missing phases cannot fall back
  // to the genuinely older wire protocol, which had no responses/memento declaration.
  throw new TrustedCodexEnvironmentValidationError("Native Codex compaction declares an invalid phase");
}

function environmentClaim(parsed: CodexParsedRequest, text: string): ChatGptEnvironmentClaim {
  return {
    environment: parseChatGptEnvironmentText(parsed, text),
    statesNetworkAccess: /<network_access\b/i.test(text) || /network access is /i.test(text),
  };
}

/** Parse only after the caller has proved this exact message in the native current checkpoint. */
export function extractChatGptEnvironmentMessageClaim(
  parsed: CodexParsedRequest, message: ChatGptUnattributedEnvironmentMessage,
): ChatGptEnvironmentClaim {
  const texts = (Array.isArray(message.content) ? message.content : []).flatMap(part => {
    const text = record(part)?.text;
    return typeof text === "string" && /^<environment_context>[\s\S]*<\/environment_context>$/.test(text.trim())
      ? [text.trim()] : [];
  });
  if (texts.length !== 1) {
    throw new TrustedCodexEnvironmentValidationError("Codex rollout does not authenticate the current environment message");
  }
  return environmentClaim(parsed, texts[0]!);
}

/** Parse a claim only: the caller must compare it with this turn's native rollout authority. */
export function extractChatGptContinuationEnvironmentClaim(parsed: CodexParsedRequest): ChatGptEnvironmentClaim {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const body = record(parsed._rawBody);
  const updates = (Array.isArray(body?.input) ? body.input : []).flatMap((value, index) => {
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
      return /^<environment_context>[\s\S]*<\/environment_context>$/.test(text) ? [{ text, index }] : [];
    });
  });
  if (updates.length === 1) return environmentClaim(parsed, updates[0]!.text);
  // A rebuilt full preamble followed by midnight's date-only fragment is one
  // environment plus a delta, not two competing complete grants. Every later
  // fragment must pass the existing strict calendar parser, and the store must
  // still compare its roots/profile with the exact current native rollout.
  const first = updates[0];
  if (first && updates.some((update, index) => index > 0 && update.index === first.index)) {
    throw new TrustedCodexEnvironmentValidationError("Compaction continuation requires one current native environment claim");
  }
  const calendarDelta = first && extractChatGptCalendarEnvironmentDelta(parsed, { afterEnvironmentIndex: first.index });
  if (!first || !calendarDelta) throw new TrustedCodexEnvironmentValidationError("Compaction continuation requires one current native environment claim");
  return { ...environmentClaim(parsed, first.text), calendarDelta };
}

/**
 * Pre-turn native compaction can rebuild the current preamble before retained older
 * instructions, without a bridge-owned checkpoint. These items are claims only;
 * the rollout reader must match both against its latest native replacement history.
 */
export function extractChatGptNativeCompactionEnvironment(parsed: CodexParsedRequest): {
  claim: ChatGptEnvironmentClaim;
  items: Record<string, unknown>[];
} | undefined {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  if (!turnId) return undefined;
  const claims = input.flatMap((value, index) => {
    const item = record(value);
    return hasEnvironmentContextFragment(item) && (itemTurnId(item) === undefined || itemTurnId(item) === turnId)
      ? [{ item, index }] : [];
  });
  if (claims.length !== 1) return undefined;
  const { item, index } = claims[0]!;
  const kinds = record(item.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  if (itemTurnId(item) !== turnId || typeof item.id !== "string" || !item.id
    || !Array.isArray(kinds) || !kinds.includes("environments.environment_context")) return undefined;
  const checkpoints = input.flatMap((value, index) => {
    const item = record(value);
    return item?.type === "compaction" ? [{ item, index }] : [];
  });
  if (checkpoints.length !== 1) return undefined;
  const checkpoint = checkpoints[0]!;
  const activeIndex = input.findLastIndex(value => isNativeInstruction(record(value), clientTurnMetadata(parsed)));
  if (checkpoint.index <= index || activeIndex <= checkpoint.index
    || itemTurnId(input[activeIndex]) !== turnId
    || typeof checkpoint.item.id !== "string" || !checkpoint.item.id
    || typeof checkpoint.item.encrypted_content !== "string" || !checkpoint.item.encrypted_content) return undefined;
  return { claim: extractChatGptContinuationEnvironmentClaim(parsed), items: [item, checkpoint.item] };
}

/**
 * Steering can separate the original environment/instruction pair from the active instruction.
 * Git workspace metadata need not list every native filesystem root. Return that earlier claim
 * only for a same-turn pair; the store must compare it with the current canonical rollout.
 */
export function extractChatGptSteeringEnvironmentClaim(parsed: CodexParsedRequest): ChatGptEnvironmentClaim | undefined {
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
    if (text) return environmentClaim(parsed, text);
  }
  return undefined;
}

/**
 * Native world-state diffs omit unchanged cwd/shell at midnight but repeat the filesystem
 * profile. Recognize the calendar fragment as a claim only: the store
 * still requires this exact turn's native rollout and corroborating current sandbox metadata.
 * Unknown profiles/fields are deliberately not classified as permission-neutral updates.
 */
export function extractChatGptCalendarEnvironmentDelta(
  parsed: CodexParsedRequest,
  options?: { afterEnvironmentIndex: number },
): ChatGptCalendarEnvironmentDelta | undefined {
  const metadata = clientTurnMetadata(parsed);
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!metadata || !turnId) return undefined;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const activeIndex = options?.afterEnvironmentIndex
    ?? input.findLastIndex(value => isNativeInstruction(record(value), metadata));
  const active = record(input[activeIndex]);
  if (itemTurnId(active) !== turnId || typeof active?.id !== "string" || !active.id) return undefined;
  if (options) {
    const kinds = record(active.internal_chat_message_metadata_passthrough)?.content_item_kinds;
    if (active.type !== "message" || active.role !== "user" || !Array.isArray(kinds)
      || !kinds.includes("environments.environment_context")) return undefined;
  }

  let deltas = 0;
  const workspaceRoots: string[][] = [];
  const filesystemProfiles: string[] = [];
  for (let index = activeIndex + 1; index < input.length; index += 1) {
    const item = record(input[index]);
    if (!hasEnvironmentContextFragment(item)) continue;
    if (item.role !== "user" || itemTurnId(item) !== turnId || typeof item.id !== "string" || !item.id) return undefined;
    const text = rawMessageText(item).trim();
    // Match the whole native fragment, not just the presence of a permission profile: another
    // profile, a malformed cwd, or any additional permission declaration must fail closed.
    // Native midnight updates can also repeat a worker inventory. Its exact name-only
    // shape is contextual; it grants neither filesystem authority nor child ownership.
    const match = /^<environment_context>\s*<current_date>\d{4}-\d{2}-\d{2}<\/current_date>\s*(?:<timezone>[^<>]+<\/timezone>\s*)?<filesystem>\s*(?:<workspace_roots>((?:\s*<root>[^<>]+<\/root>\s*)+)<\/workspace_roots>\s*)?(<permission_profile type="(?:disabled|managed)">[\s\S]*?<\/permission_profile>)\s*<\/filesystem>\s*(?:<subagents>\s*(?:<agent name="[^<>"\r\n]+"\s*\/>\s*)*<\/subagents>\s*)?<\/environment_context>$/.exec(text);
    if (!match
      || !sandboxMetadataMatchesEnvironment(canonicalSandboxMetadata(metadata), text)
      || [metadata.sandbox_mode, metadata.sandbox].some(value => (
        value !== undefined && !sandboxMetadataMatchesEnvironment(value, text)
      ))) return undefined;
    // Compare the complete rendered profile against the native record in the store.
    // Only insignificant whitespace between XML tags is normalized.
    filesystemProfiles.push(match[2]!.replace(/>\s+</g, "><"));
    if (match[1]) {
      let roots: string[];
      try { roots = [...match[1].matchAll(/<root>([^<]+)<\/root>/g)].map(root => decodeXmlText(root[1]!.trim())); }
      catch { return undefined; }
      if (roots.some(root => !isAbsolute(root))) return undefined;
      workspaceRoots.push([...new Set(roots.map(pathIdentity))]);
    }
    deltas += 1;
  }
  // A native delta may precede the first assistant response (#812). Its current-turn
  // attribution permits verification, never authority: all repeated roots must agree
  // with the current rollout before the store can accept this update.
  return deltas > 0 ? { workspaceRoots, filesystemProfiles } : undefined;
}

function environmentBeforeUser(input: unknown[], userIndex: number, expectedTurnId?: string, metadata?: Record<string, unknown>): string | undefined {
  if (userIndex <= 0) return undefined;
  const user = record(input[userIndex]);
  if (!isNativeInstruction(user, metadata)) return undefined;

  const userTurnId = itemTurnId(user);
  if (!userTurnId || (expectedTurnId && userTurnId !== expectedTurnId)) return undefined;

  let candidateIndex = userIndex - 1;
  let candidate = record(input[candidateIndex]);
  while (inputItemType(candidate) === "message" && candidate !== undefined
    && (candidate.role === "developer" || isNativeOpenPageContext(candidate))) {
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

  let paths: ReturnType<typeof environmentPaths>;
  try {
    paths = environmentPaths(environmentText, normalizedMetadataRoots);
  } catch {
    return false;
  }
  const declaredRoots = paths.roots.map(pathIdentity);
  // Without a stated cwd this is only a partial claim. The store must obtain
  // the cwd from the current native rollout and validate its workspace metadata.
  if (paths.cwd !== undefined && normalizedMetadataRoots.length > 0
    && !normalizedMetadataRoots.some(root => matchesPath(root, paths.cwd!))) return false;
  if (requireMetadataBoundRoots && (
    normalizedMetadataRoots.length === 0
    || declaredRoots.some(root => (
      !normalizedMetadataRoots.some(metadataRoot => matchesPath(metadataRoot, root))
      && !isCurrentOrParentThreadVisualizationRoot(root, metadata)
    ))
  )) return false;
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
    && (candidate.role === "developer" || compactionSummaryMessage(candidate) || isNativeOpenPageContext(candidate))) {
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
    // structurally adjacent context (allowing provenance-checked developer and native page items) to
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
    return [...text.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map(match => match[1] ?? "");
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
  const environment = extractChatGptTurnEnvironmentClaim(parsed).environment;
  if (environment.cwd === undefined) throw new MissingTrustedCodexEnvironmentError("cwd");
  return { ...environment, cwd: environment.cwd };
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

export function extractChatGptTurnEnvironmentClaim(parsed: CodexParsedRequest): ChatGptEnvironmentClaim {
  const text = trustedEnvironmentText(parsed);
  const claim = environmentClaim(parsed, text);
  const input = record(parsed._rawBody)?.input;
  const messages = Array.isArray(input) ? input.map(record).filter(item => {
    if (item?.role !== "user" || typeof item.id !== "string" || !item.id) return false;
    const parts = typeof item.content === "string" ? [item.content]
      : Array.isArray(item.content) ? item.content.map(part => record(part)?.text) : [];
    return parts.some(part => typeof part === "string" && part.trim() === text.trim());
  }) : [];
  const source = messages.length === 1 ? messages[0] : undefined;
  // Duplicate ids or identical competing envelopes cannot identify the selected native message.
  if (source && (input as unknown[]).filter(value => record(value)?.id === source.id).length === 1) {
    claim.sourceMessage = { id: source.id as string, content: source.content };
  }
  return claim;
}

function environmentPaths(text: string, preferredRoots: string[]): { cwd?: string; roots: string[] } {
  const cwdMatches = environmentCwdMatches(text, preferredRoots);
  const rootSections = [...text.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/g)];
  const rootMatches = rootSections
    .flatMap(section => [...section[0].matchAll(/<root>([^<]+)<\/root>/g)].map(match => match[1] ?? ""));
  if (cwdMatches.length === 0) {
    // Only a well-formed filesystem-only update may omit cwd. Malformed cwd,
    // ambiguous environments, and incomplete root lists remain invalid claims.
    if (/<\/?(?:cwd|environments)\b/i.test(text) || rootSections.length !== 1 || rootMatches.length === 0
      || [...text.matchAll(/<workspace_roots\b[^>]*>/gi)].length !== 1
      || [...text.matchAll(/<\/workspace_roots\s*>/gi)].length !== 1
      || [...rootSections[0]![0].matchAll(/<root\b[^>]*>/gi)].length !== rootMatches.length
      || [...rootSections[0]![0].matchAll(/<\/root\s*>/gi)].length !== rootMatches.length) {
      throw new MissingTrustedCodexEnvironmentError("cwd");
    }
    return { roots: uniqueAbsolutePaths(rootMatches, "workspace_roots") };
  }
  const cwdCandidates = uniqueAbsolutePaths(cwdMatches, "cwd");
  if (cwdCandidates.length !== 1) {
    throw new TrustedCodexEnvironmentValidationError("ChatGPT web turn has conflicting trusted Codex cwd values");
  }
  const cwd = cwdCandidates[0]!;
  const roots = rootMatches.length > 0 ? uniqueAbsolutePaths(rootMatches, "workspace_roots") : [cwd];
  if (!roots.some(root => matchesPath(root, cwd))) {
    throw new TrustedCodexEnvironmentValidationError("ChatGPT web cwd is outside the trusted Codex workspace roots");
  }
  return { cwd, roots };
}

function parseChatGptEnvironmentText(parsed: CodexParsedRequest, text: string): ChatGptEnvironmentClaim["environment"] {
  const paths = environmentPaths(text, clientMetadataWorkspaceRoots(parsed));
  const { roots } = paths;
  const sandboxType = sandboxTypeFromEnvironment(text);
  const networkAccess = /<network_access>enabled<\/network_access>/i.test(text)
    || /network access is enabled/i.test(text);

  if (!sandboxType) {
    throw new TrustedCodexEnvironmentValidationError("ChatGPT web turn requires one explicit trusted Codex sandbox mode");
  }
  if (sandboxType === "dangerFullAccess") {
    return { ...paths, writableRoots: roots, sandboxPolicy: { type: "dangerFullAccess" }, tools: parsed.context.tools ?? [] };
  }
  if (sandboxType === "workspaceWrite") {
    return {
      ...paths,
      writableRoots: roots,
      sandboxPolicy: { type: "workspaceWrite", writableRoots: roots, networkAccess },
      tools: parsed.context.tools ?? [],
    };
  }
  return { ...paths, writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess }, tools: parsed.context.tools ?? [] };
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
