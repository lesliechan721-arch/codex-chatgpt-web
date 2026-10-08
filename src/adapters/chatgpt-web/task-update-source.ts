import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { canonicalJson } from "./canonical-json";
import { ChatGptWebAdapterError } from "./adapter-error";
import { chatGptCurrentInstructionIndex, chatGptCurrentInstructionRevision, extractChatGptTurnIdentity, trustedChatGptTaskUpdateUserText } from "./environment";

export interface TaskUpdateExecutionIdentity {
  /** Resolved by the trusted adapter: account/connector, namespace, authority and epoch identity. */
  capabilityIdentity: unknown;
  executionConfig?: unknown;
}

export interface TaskUpdateSourceMessage {
  sourceMessageId: string;
  content: string;
  payloadDigest: string;
  representationDigest: string;
}

export interface TaskUpdateSourceProof {
  continuity?: true;
  currentMessageId?: string;
  currentInstruction?: unknown;
  conflictingMessageIds?: readonly string[];
  threadId: string;
  turnId: string;
  immutableDigest: string;
  messages: readonly TaskUpdateSourceMessage[];
  requestFingerprint: string;
  /** A native request ID when one exists; otherwise the exact request fingerprint. */
  requestIdentity: string;
  input: readonly unknown[];
}

export function taskUpdateDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function taskUpdateSourceError(code: string, message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 409, errorType: "invalid_request_error", code, retryable: false,
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function instructionRepresentation(item: Record<string, unknown>): unknown {
  const metadata = record(item.internal_chat_message_metadata_passthrough);
  // Native producer timestamps and transport IDs are not permission or instruction content.
  const { create_time: _created, ...provenance } = metadata ?? {};
  const { internal_chat_message_metadata_passthrough: _metadata, ...representation } = item;
  return { ...representation, ...(metadata ? { internal_chat_message_metadata_passthrough: provenance } : {}) };
}

/** Caller has already completed ordinary native identity/environment validation. */
export function captureTaskUpdateSource(
  parsed: CodexParsedRequest,
  execution: TaskUpdateExecutionIdentity,
): TaskUpdateSourceProof | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  const body = record(parsed._rawBody);
  if (parsed._compactionRequest
    || !identity.threadId || !identity.turnId || identity.subagentKind
    || execution.capabilityIdentity === undefined || !Array.isArray(body?.input)) return undefined;
  const messages: TaskUpdateSourceMessage[] = [];
  const continuity = parsed._conversationPolicy === "continuity-first";
  const conflictingMessageIds: string[] = [];
  const prefix: unknown[] = [];
  const ids = new Set<string>();
  for (const [index, value] of body.input.entries()) {
    const item = record(value);
    if (!item) continue;
    let user = trustedChatGptTaskUpdateUserText(item, identity.turnId);
    // The native resolver can establish the current input when optional wire fields are absent.
    if (!user && continuity && index === chatGptCurrentInstructionIndex(parsed)) {
      const current = chatGptCurrentInstructionRevision(parsed);
      if (current) user = trustedChatGptTaskUpdateUserText({ ...item,
        id: current.itemId ?? `turn:${identity.turnId}`,
        internal_chat_message_metadata_passthrough: {
          ...record(item.internal_chat_message_metadata_passthrough), turn_id: identity.turnId,
        } }, identity.turnId);
    }
    if (user) {
      const sourceMessageId = continuity ? parsed._chatGptMessageIdAliases?.[user.sourceMessageId] ?? user.sourceMessageId : user.sourceMessageId;
      if (ids.has(sourceMessageId)) {
        if (continuity) {
          if (messages.find(message => message.sourceMessageId === sourceMessageId)?.payloadDigest !== taskUpdateDigest(user.content)) {
            conflictingMessageIds.push(sourceMessageId);
          }
          continue;
        }
        throw taskUpdateSourceError("task_update_source_conflict", "A native user message identity is duplicated.");
      }
      ids.add(sourceMessageId);
      messages.push({ sourceMessageId, content: user.content,
        payloadDigest: taskUpdateDigest(user.content),
        representationDigest: taskUpdateDigest(instructionRepresentation(user.item)) });
    } else if (["system", "developer", "user"].includes(String(item.role))
      || item.type === "agent_message"
      || (item.type === "function_call_output" && item.call_id === undefined)) {
      prefix.push({ afterSourceMessageId: messages.at(-1)?.sourceMessageId ?? null,
        instruction: instructionRepresentation(item) });
    }
  }
  if (messages.length === 0 && !continuity) return undefined;
  const input = structuredClone(body.input);
  const requestFingerprint = taskUpdateDigest({ input, modelId: parsed.modelId, options: parsed.options,
    instructions: body.instructions ?? null, previousResponseId: parsed.previousResponseId ?? null });
  const metadataRaw = record(body.client_metadata)?.["x-codex-turn-metadata"];
  let metadata = record(metadataRaw);
  if (typeof metadataRaw === "string") { try { metadata = record(JSON.parse(metadataRaw)); } catch {} }
  const requestId = metadata?.request_id ?? body.request_id ?? body.id;
  const current = continuity ? chatGptCurrentInstructionRevision(parsed) : undefined;
  return {
    ...(continuity ? { continuity: true as const } : {}),
    ...(conflictingMessageIds.length ? { conflictingMessageIds } : {}),
    ...(current ? { currentMessageId: current.itemId
      ? parsed._chatGptMessageIdAliases?.[current.itemId] ?? current.itemId : `turn:${identity.turnId}`,
    currentInstruction: structuredClone(body.input[chatGptCurrentInstructionIndex(parsed)]) } : {}),
    threadId: identity.threadId, turnId: identity.turnId,
    immutableDigest: continuity ? taskUpdateDigest({ threadId: identity.threadId, turnId: identity.turnId,
      scope: parsed._continuityScope, capabilityIdentity: execution.capabilityIdentity }) : taskUpdateDigest({ threadId: identity.threadId, turnId: identity.turnId,
      modelId: parsed.modelId, modelFamily: parsed._chatgptModelFamily ?? null,
      options: parsed.options, instructions: body.instructions ?? null, prefix,
      capabilityIdentity: execution.capabilityIdentity, executionConfig: execution.executionConfig ?? null }),
    messages, requestFingerprint,
    requestIdentity: typeof requestId === "string" && requestId ? `native:${requestId}` : requestFingerprint,
    input,
  };
}

export function assertTaskUpdateSourceExtension(
  accepted: TaskUpdateSourceProof,
  incoming: TaskUpdateSourceProof,
): "extension" | "equal" | "stale" {
  if (accepted.threadId !== incoming.threadId || accepted.turnId !== incoming.turnId
    || accepted.immutableDigest !== incoming.immutableDigest) {
    throw taskUpdateSourceError("task_update_source_conflict", "Task update changed the accepted native identity, instructions, environment or execution configuration.");
  }
  const common = Math.min(accepted.messages.length, incoming.messages.length);
  for (let index = 0; index < common; index++) {
    const old = accepted.messages[index]!;
    const next = incoming.messages[index]!;
    if (old.sourceMessageId !== next.sourceMessageId || old.payloadDigest !== next.payloadDigest
      || old.representationDigest !== next.representationDigest) {
      throw taskUpdateSourceError("task_update_source_conflict", "Task update does not preserve the complete accepted user instruction prefix.");
    }
  }
  return incoming.messages.length < accepted.messages.length ? "stale"
    : incoming.messages.length === accepted.messages.length ? "equal" : "extension";
}

export function isTaskUpdateRawResult(item: Record<string, unknown>): boolean {
  return ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(String(item.type));
}

/** Bind every raw field: parsed text alone loses image/resource/error/metadata evidence. */
export function taskUpdateRawResultDigest(item: Record<string, unknown>): string {
  return taskUpdateDigest(item);
}
