import type { CodexParsedRequest } from "../../types";
import { isReadableCompactionSummaryText, OPAQUE_COMPACTION_NOTE } from "../../responses/compaction";
import { isNativeAgentsMdContext } from "../../responses/native-context";

export interface ChatGptTurnUserRevision {
  content: unknown;
  turnId?: string;
  itemId?: string;
  instructionEnvelope?: Record<string, unknown>;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function inputItemType(item: Record<string, unknown> | undefined): unknown {
  return item?.type ?? (typeof item?.role === "string" ? "message" : undefined);
}

export function clientTurnMetadataFromBody(value: unknown): Record<string, unknown> | undefined {
  const body = record(value);
  const metadata = record(body?.client_metadata);
  const raw = metadata?.["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    try { return record(JSON.parse(raw)); }
    catch { return undefined; }
  }
  return record(raw);
}

export function clientTurnMetadata(parsed: CodexParsedRequest): Record<string, unknown> | undefined {
  return clientTurnMetadataFromBody(parsed._rawBody);
}

export function itemTurnId(value: unknown): string | undefined {
  const turnId = record(record(value)?.internal_chat_message_metadata_passthrough)?.turn_id;
  return typeof turnId === "string" ? turnId : undefined;
}

export function rawMessageText(value: Record<string, unknown>): string {
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content
    .map(part => record(part)?.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/** Native context is a user fragment, never an XML mention in an answer, tool result or request. */
export function hasEnvironmentContextFragment(item: Record<string, unknown> | undefined): item is Record<string, unknown> {
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

export function contextualUserMessage(value: Record<string, unknown>): boolean {
  const text = rawMessageText(value).trim();
  return hasEnvironmentContextFragment(value)
    || isNativeAgentsMdContext(value)
    || isNativeOpenPageContext(value)
    || /^<subagent_notification>[\s\S]*<\/subagent_notification>$/.test(text)
    || isReadableCompactionSummaryText(text)
    || text === OPAQUE_COMPACTION_NOTE;
}

/** Page context is not an instruction; literal wrappers in ordinary user text still are. */
export function isNativeOpenPageContext(item: Record<string, unknown> | undefined): boolean {
  if (item?.type !== "message" || item.role !== "user"
    || typeof item.id !== "string" || !item.id || !itemTurnId(item)?.trim()) return false;
  const kinds = record(item.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  return Array.isArray(kinds) && kinds.length === 1 && kinds[0] === "additional_content.codex_apps_open_page";
}

/** The desktop injects cross-task messages as synthetic tool outputs without a call_id. */
export function isDelegatedInstruction(item: Record<string, unknown> | undefined): boolean {
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
export function isNativeInstruction(
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

export function isTurnAbortedNotice(value: Record<string, unknown>): boolean {
  return /^<turn_aborted>[\s\S]*<\/turn_aborted>$/.test(rawMessageText(value).trim());
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

export function continuityInstructionSelection(parsed: CodexParsedRequest, input: unknown[]): ContinuityInstructionSelection | undefined {
  if (parsed._conversationPolicy !== "task") return undefined;
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
    const revision = userRevision(input[index], expectedTurnId, metadata, parsed._conversationPolicy === "task");
    if (revision) {
      selection?.carried.set(expectedTurnId, index);
      return revision;
    }
  }
  selection?.carried.set(expectedTurnId, -1);
  return undefined;
}

/** Preserve the instruction roles that the prompt compiler treats differently. */
export function chatGptInstructionEnvelope(item: Record<string, unknown>): Record<string, unknown> {
  return item.type === "agent_message"
    ? { role: "agent_message", author: item.author, recipient: item.recipient }
    : { role: item.type === "function_call_output" ? "tool_result" : item.role };
}

export function userRevision(value: unknown, expectedTurnId?: string, metadata?: Record<string, unknown>, includeEnvelope = false): ChatGptTurnUserRevision | undefined {
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
