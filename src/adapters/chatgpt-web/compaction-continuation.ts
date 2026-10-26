import { createHash } from "node:crypto";
import { parseRequest } from "../../responses/parser";
import { readNativeThreadDelegation } from "../../responses/native-context";
import { decodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexMessage, CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity, requestCarriedChatGptInstructionRevision, type ChatGptTurnIdentity, type ChatGptTurnUserRevision } from "./environment";
import { continuityError } from "./continuity-errors";
import { continuityCheckpoint, continuityDigest, continuitySourceRepresentationDigest, findContinuityRecoveryRecord, selectContinuityCheckpoint } from "./continuity-binding";
import { selectRecoveryContinuation } from "./continuity-recovery-continuation";
import type { RecoveryThreadRecord, RecoveryWorkRecord } from "./continuity-recovery-store";

interface CompletedCheckpoint {
  summaryHash: string;
  sourceHashes: ReadonlySet<string>;
  source: ChatGptTurnUserRevision;
  sourceWasSyntheticInstruction: boolean;
  sourceWasDelegation: boolean;
  sourceWasGoal: boolean;
  taskMessage?: CodexMessage;
  taskItemId?: string;
}

// Evidence of a checkpoint actually returned by this daemon, not authority inferred from text
// that happens to look like a summary. A new process must not invent a missing handoff.
const checkpoints = new Map<string, CompletedCheckpoint>();
const MAX_CHECKPOINTS = 256;
const reservations = new Set<string>();
// Missing instruction content is never reconstructed from a digest. This identity-only
// object supports recognition; the recovery caller compiles the actual current context.
const durableSources = new WeakMap<CodexParsedRequest, { commitId: string; workId: string; identityOnly: boolean; source: ChatGptTurnUserRevision }>();
// Only records inserted here can satisfy restoration deduplication. Equal historical
// text is not the current source identity, even when it has the same model role.
const restoredTasks = new WeakMap<CodexMessage, string>();
// Like instruction selection, this scan belongs to one parsed input. Rebuilt input
// has a new identity. Cache only its shape, never durable source or writer authority.
const checkpointPresence = new WeakMap<CodexParsedRequest, { input: unknown[]; length: number; present: boolean }>();

function hasCarriedCheckpoint(parsed: CodexParsedRequest): boolean {
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) return false;
  const cached = checkpointPresence.get(parsed);
  if (cached?.input === input && cached.length === input.length) return cached.present;
  const present = continuityCheckpoint(parsed).index >= 0;
  checkpointPresence.set(parsed, { input, length: input.length, present });
  return present;
}

function durableContinuation(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity) {
  if (!parsed._continuityScope || !identity.threadId || !identity.turnId) return undefined;
  const record = findContinuityRecoveryRecord(continuityDigest(identity.threadId), parsed._continuityScope, parsed._continuityStateDirectory);
  if (!record) return undefined;
  const selected = selectRecoveryContinuation(parsed, record, identity);
  if (!selected) return undefined;
  let sourceWork = record.works[selected.checkpoint.sourceLogicalWorkId]!;
  if (selected.checkpoint.representationDigests.some(digest => digest === CONTINUITY_DELEGATION_SOURCE || digest === CONTINUITY_GOAL_SOURCE)) {
    sourceWork = originalSyntheticWork(record, sourceWork, selected.checkpoint.sourceIdentity);
  }
  return { ...selected, sourceWork };
}

function originalSyntheticWork(record: RecoveryThreadRecord, source: RecoveryWorkRecord, identity: string): RecoveryWorkRecord {
  const seen = new Set<string>();
  while (source.allowRetainedSourceFallback) {
    if (seen.has(source.logicalWorkId)) throw continuityError("continuity_source_unproven");
    seen.add(source.logicalWorkId);
    const previous = source.predecessorLogicalWorkId ? record.works[source.predecessorLogicalWorkId] : undefined;
    if (!previous || previous.purpose !== "ordinary" || previous.workLineageId !== source.workLineageId
      || previous.instructionIdentity !== identity || source.instructionIdentity !== identity
      || previous.workPayloadDigest !== source.workPayloadDigest || previous.acceptedTaskRevision !== source.acceptedTaskRevision
      || !Object.values(record.checkpoints).some(checkpoint => checkpoint.sourceLogicalWorkId === previous.logicalWorkId
        && checkpoint.sourceIdentity === identity && checkpoint.workLineageId === source.workLineageId
        && checkpoint.continuation.state === "consumed" && checkpoint.continuation.consumerLogicalWorkId === source.logicalWorkId)) {
      throw continuityError("continuity_source_unproven", "The synthetic task source has no exact retained predecessor relation.");
    }
    source = previous;
  }
  return source;
}

function liveCheckpoint(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity) {
  try { return selectContinuityCheckpoint(parsed, identity); }
  catch (error) {
    // A missing page cannot discard an existing durable relationship. Other source and
    // payload conflicts are preserved, rather than hidden by this recognition fallback.
    if (error && typeof error === "object" && "code" in error && error.code === "continuity_session_lost") return undefined;
    throw error;
  }
}

function scope(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): string | undefined {
  if (!identity.threadId || !identity.turnId) return undefined;
  if (parsed._conversationPolicy === "task") return undefined;
  return JSON.stringify([identity.threadId, identity.turnId, parsed.modelId, parsed.options.reasoning]);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceDigest(source: ChatGptTurnUserRevision): string {
  return digest([source.turnId, source.content]);
}

function makeCheckpointRoom(key: string): void {
  if (checkpoints.has(key) || reservations.has(key)) return;
  while (new Set([...checkpoints.keys(), ...reservations]).size >= MAX_CHECKPOINTS) {
    const evictable = [...checkpoints].find(([candidate]) => !reservations.has(candidate));
    if (!evictable) throw continuityError("continuity_resource_capacity", "The checkpoint evidence registry is full.");
    checkpoints.delete(evictable[0]);
  }
}

/** Reserve evidence capacity before a strict handoff touches the retained conversation. */
export function reserveCompactionContinuation(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): () => void {
  const key = scope(parsed, identity);
  if (!key) throw continuityError("continuity_source_unproven");
  makeCheckpointRoom(key);
  reservations.add(key);
  return () => { reservations.delete(key); };
}

// This digest is metadata in an exact checkpoint relation. It contains no source body and
// never selects a source by itself, so existing durable records remain readable.
export const CONTINUITY_DELEGATION_SOURCE = continuityDigest(["continuity-compaction-source-delegation-v1"]);
export const CONTINUITY_GOAL_SOURCE = continuityDigest(["continuity-compaction-source-goal-v1"]);
export const CONTINUITY_IDENTITY_ONLY_SOURCE = continuityDigest(["continuity-compaction-source-identity-only-v1"]);

function canonicalItemId(parsed: CodexParsedRequest, id: unknown): unknown {
  return typeof id === "string" ? parsed._chatGptMessageIdAliases?.[id] ?? id : id;
}

function matchesRevision(parsed: CodexParsedRequest, item: Record<string, unknown>, source: ChatGptTurnUserRevision): boolean {
  return canonicalItemId(parsed, item.id) === canonicalItemId(parsed, source.itemId)
    && digest([(item.internal_chat_message_metadata_passthrough as { turn_id?: unknown } | undefined)?.turn_id,
      item.type === "function_call_output" ? item.output : item.content]) === sourceDigest(source);
}

function nativeGoal(item: Record<string, unknown>): boolean {
  const metadata = item.internal_chat_message_metadata_passthrough as { turn_id?: unknown; content_item_kinds?: unknown } | undefined;
  return (item.type === "message" || item.type === undefined) && item.role === "user"
    && typeof item.id === "string" && !!item.id
    && typeof metadata?.turn_id === "string" && !!metadata.turn_id.trim()
    && Array.isArray(metadata.content_item_kinds) && metadata.content_item_kinds.length === 1
    && metadata.content_item_kinds[0] === "goal.internal_context";
}

export function compactionSourceWasGoal(parsed: CodexParsedRequest, source: ChatGptTurnUserRevision): boolean {
  const input = (parsed._rawBody as { input?: Array<Record<string, unknown>> } | undefined)?.input;
  if (Array.isArray(input) && input.some(item => item && matchesRevision(parsed, item, source) && nativeGoal(item))) return true;
  const previous = recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed));
  return previous?.sourceWasGoal === true
    && canonicalItemId(parsed, previous.source.itemId) === canonicalItemId(parsed, source.itemId)
    && sourceDigest(previous.source) === sourceDigest(source);
}

export function compactionSourceWasDelegation(parsed: CodexParsedRequest, source: ChatGptTurnUserRevision): boolean {
  const input = (parsed._rawBody as { input?: Array<Record<string, unknown>> } | undefined)?.input;
  const canonicalId = (id: unknown): unknown => typeof id === "string" ? parsed._chatGptMessageIdAliases?.[id] ?? id : id;
  if (source.itemId !== undefined && Array.isArray(input)
    && (!source.instructionEnvelope || source.instructionEnvelope.role === "tool_result")
    && input.some(item => canonicalId(item?.id) === canonicalId(source.itemId) && item.type === "function_call_output"
      && item.name === "send_message_to_thread" && item.namespace === "codex_app" && item.call_id === undefined
      && (item.internal_chat_message_metadata_passthrough as { turn_id?: unknown } | undefined)?.turn_id === source.turnId
      && item.output === source.content)) return true;
  // Later compactions can omit the synthetic item. Only the exact earlier completed
  // checkpoint carries its provenance; a later steering instruction keeps its own source.
  const previous = recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed));
  return previous?.sourceWasDelegation === true && canonicalId(previous.source.itemId) === canonicalId(source.itemId)
    && sourceDigest(previous.source) === sourceDigest(source);
}

export function rememberCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  sources: readonly ChatGptTurnUserRevision[],
  summary: string,
): void {
  const key = scope(parsed, identity);
  if (!key || !parsed._compactionRequest || !summary || !sources[0]) return;
  makeCheckpointRoom(key);
  const prior = checkpoints.get(key);
  const summaryHash = digest(summary);
  const sameSummary = prior?.summaryHash === summaryHash;
  const sourceHashes = sameSummary ? new Set(prior.sourceHashes) : new Set<string>();
  for (const source of sources) sourceHashes.add(sourceDigest(source));
  const input = (parsed._rawBody as { input?: Array<Record<string, unknown>> } | undefined)?.input;
  const accepted = acceptedCheckpoint(parsed, identity);
  const sourceItem = input?.find(item => item && matchesRevision(parsed, item, sources[0]!));
  const taskSource = sourceItem && (nativeGoal(sourceItem) || readNativeThreadDelegation(sourceItem));
  const taskMessage = taskSource
    ? parseRequest({ model: parsed.modelId, input: [sourceItem] }).context.messages[0]
    : accepted?.checkpoint.taskMessage && accepted.checkpoint.sourceHashes.has(sourceDigest(sources[0]))
      && !input?.slice(accepted.summaryIndex + 1).some(item => item && matchesRevision(parsed, item, sources[0]!))
      ? accepted.checkpoint.taskMessage : undefined;
  const taskItemId = taskSource ? String(sourceItem.id) : taskMessage ? accepted?.checkpoint.taskItemId : undefined;
  const sourceWasDelegation = compactionSourceWasDelegation(parsed, sources[0]);
  const sourceWasGoal = compactionSourceWasGoal(parsed, sources[0]);
  const sourceWasSyntheticInstruction = sourceWasDelegation || sourceWasGoal;
  checkpoints.delete(key);
  checkpoints.set(key, {
    summaryHash, sourceHashes,
    // Equal summary text can cover a newer steering instruction. Keep its actual source
    // and provenance while the accepted producer representations continue to accumulate.
    source: structuredClone(sources[0]),
    sourceWasSyntheticInstruction, sourceWasDelegation, sourceWasGoal,
    ...(taskMessage ? { taskMessage: structuredClone(taskMessage), taskItemId } : {}),
  });
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some(part => !part || typeof part.text !== "string")) return undefined;
  return content.map(part => part.text).join("\n");
}

/** Restore dropped native task context without changing authorization or raw request history. */
export function restoreCompactionTaskMessages(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  revisions: readonly ChatGptTurnUserRevision[],
): CodexMessage[] {
  const input = (parsed._rawBody as { input?: Array<Record<string, unknown>> } | undefined)?.input;
  if (!Array.isArray(input)) return parsed.context.messages;
  const accepted = acceptedCheckpoint(parsed, identity);
  const recovered = parsed._conversationPolicy === "task" ? recoverCompactionInstruction(parsed, identity) : undefined;
  let taskMessage = accepted?.checkpoint.taskMessage;
  let taskItemId = accepted?.checkpoint.taskItemId;
  let summaryIndex = accepted?.summaryIndex;
  let summaryHash = accepted?.checkpoint.summaryHash;
  if (recovered?.sourceWasSyntheticInstruction) {
    summaryIndex = recovered.summaryIndex;
    const item = input[summaryIndex]!;
    const summary = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content)
      : messageText(item.content)?.slice(SUMMARY_PREFIX.length + 1);
    if (summary === null || summary === undefined) return parsed.context.messages;
    summaryHash = digest(summary);
    let content = messageText(recovered.source.content);
    if (isDurableCompactionSourceIdentity(parsed, recovered.source)) {
      // Only the exact authenticated checkpoint may supply model-visible task text after restart.
      // The identity-only source remains unchanged and continues to govern authorization.
      const marker = "\nCODEX_LATEST_USER_PROMPT_JSON\n";
      const offset = summary.lastIndexOf(marker);
      if (offset >= 0) {
        try { const value = JSON.parse(summary.slice(offset + marker.length)); if (typeof value === "string") content = value; }
        catch { return parsed.context.messages; }
      }
    }
    if (!content) return parsed.context.messages;
    taskItemId = recovered.source.itemId;
    if (recovered.sourceWasDelegation) {
      const delegation = readNativeThreadDelegation({ type: "function_call_output", name: "send_message_to_thread",
        namespace: "codex_app", id: taskItemId, output: content,
        internal_chat_message_metadata_passthrough: { turn_id: recovered.source.turnId } });
      if (!delegation) return parsed.context.messages;
      taskMessage = { role: "agentMessage", author: delegation.sourceThreadId, content, timestamp: Date.now() };
    } else taskMessage = { role: "user", content, timestamp: Date.now() };
  }
  if (!taskMessage || summaryIndex === undefined || !summaryHash) return parsed.context.messages;
  // A new steering item supersedes this task even when it repeats earlier wording or has no id.
  const hasNewInstruction = input.slice(summaryIndex + 1).some(item => item && revisions.some(revision =>
    matchesRevision(parsed, item, revision)));
  if (hasNewInstruction || input.some(item => canonicalItemId(parsed, item?.id) === canonicalItemId(parsed, taskItemId))) {
    return parsed.context.messages;
  }
  const messageIndex = parsed.context.messages.findLastIndex(message => {
    if (message.role !== "user" || typeof message.content !== "string"
      || !isReadableCompactionSummaryText(message.content)) return false;
    const text = message.content.slice(SUMMARY_PREFIX.length + 1);
    return digest(text) === summaryHash || text.startsWith("\n") && digest(text.slice(1)) === summaryHash;
  });
  if (messageIndex < 0) return parsed.context.messages;
  const taskProjection = (message: CodexMessage) => digest([message.role, message.content,
    message.role === "agentMessage" ? message.author : undefined, message.role === "agentMessage" ? message.recipient : undefined]);
  const taskDigest = taskProjection(taskMessage);
  const restorationKey = digest([identity.threadId, identity.turnId, parsed.modelId, parsed.options.reasoning,
    canonicalItemId(parsed, taskItemId), summaryHash, taskDigest]);
  const next = parsed.context.messages[messageIndex + 1];
  if (next && restoredTasks.get(next) === restorationKey && taskProjection(next) === taskDigest) return parsed.context.messages;
  const restored = structuredClone(taskMessage);
  restoredTasks.set(restored, restorationKey);
  return [...parsed.context.messages.slice(0, messageIndex + 1), restored,
    ...parsed.context.messages.slice(messageIndex + 1)];
}

export function isAcceptedCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): boolean {
  if (parsed._conversationPolicy === "task") {
    const live = liveCheckpoint(parsed, identity);
    if (live?.checkpoint.sourceRepresentationDigests?.includes(continuitySourceRepresentationDigest(parsed, source))) return true;
    const durable = durableContinuation(parsed, identity);
    if (!durable) return false;
    const retained = durableSources.get(parsed);
    return (retained?.source === source && retained.commitId === durable.checkpoint.commitId
      && retained.workId === durable.work.logicalWorkId)
      || durable.checkpoint.representationDigests.includes(continuitySourceRepresentationDigest(parsed, source));
  }
  return acceptedCheckpoint(parsed, identity)?.checkpoint.sourceHashes.has(sourceDigest(source)) === true;
}

/** Exact checkpoint identity, including a durable placeholder published into live state. */
export function isDurableCompactionSourceIdentity(parsed: CodexParsedRequest, source: ChatGptTurnUserRevision): boolean {
  const live = liveCheckpoint(parsed, extractChatGptTurnIdentity(parsed));
  if (live?.checkpoint.sourceInstruction === source
    && live.checkpoint.sourceRepresentationDigests?.includes(CONTINUITY_IDENTITY_ONLY_SOURCE)) return true;
  const retained = durableSources.get(parsed);
  if (retained?.source !== source || !retained.identityOnly) return false;
  const durable = durableContinuation(parsed, extractChatGptTurnIdentity(parsed));
  return Boolean(durable && retained.commitId === durable.checkpoint.commitId
    && retained.workId === durable.work.logicalWorkId);
}

/** Native compaction may retain only its summary; recover the task solely from our completed handoff. */
export function recoverCompactionInstruction(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): { source: ChatGptTurnUserRevision; summaryIndex: number; sourceWasDelegation: boolean; sourceWasGoal: boolean; sourceWasSyntheticInstruction: boolean } | undefined {
  if (parsed._conversationPolicy === "task") {
    const selected = liveCheckpoint(parsed, identity);
    if (selected?.checkpoint.sourceInstruction) return {
      source: selected.checkpoint.sourceInstruction, summaryIndex: selected.summaryIndex,
      sourceWasDelegation: selected.checkpoint.sourceRepresentationDigests?.includes(CONTINUITY_DELEGATION_SOURCE) === true,
      sourceWasGoal: selected.checkpoint.sourceRepresentationDigests?.includes(CONTINUITY_GOAL_SOURCE) === true,
      sourceWasSyntheticInstruction: selected.checkpoint.sourceRepresentationDigests?.some(digest =>
        digest === CONTINUITY_DELEGATION_SOURCE || digest === CONTINUITY_GOAL_SOURCE) === true,
    };
    // The durable selector distinguishes an exact carried source from a new
    // instruction. Presence alone cannot reject the source after backend restart.
    if (!hasCarriedCheckpoint(parsed)) return undefined;
    const durable = durableContinuation(parsed, identity);
    if (!durable) return undefined;
    const carried = requestCarriedChatGptInstructionRevision(parsed, identity.turnId);
    if (carried && !durable.checkpoint.representationDigests.includes(continuitySourceRepresentationDigest(parsed, carried))) return undefined;
    const sourceWasDelegation = durable.checkpoint.representationDigests.includes(CONTINUITY_DELEGATION_SOURCE);
    const sourceWasGoal = durable.checkpoint.representationDigests.includes(CONTINUITY_GOAL_SOURCE);
    const sourceWasSyntheticInstruction = sourceWasDelegation || sourceWasGoal;
    let retained = durableSources.get(parsed);
    if (!retained || retained.commitId !== durable.checkpoint.commitId || retained.workId !== durable.work.logicalWorkId) {
      const carriedId = carried?.itemId ? parsed._chatGptMessageIdAliases?.[carried.itemId] ?? carried.itemId : undefined;
      const sourceWork = sourceWasSyntheticInstruction ? durable.sourceWork : durable.work;
      const hasCarriedSource = Boolean(carried && (!sourceWasSyntheticInstruction || carriedId === durable.checkpoint.sourceIdentity));
      retained = { commitId: durable.checkpoint.commitId, workId: durable.work.logicalWorkId, identityOnly: !hasCarriedSource,
        source: hasCarriedSource ? carried!
          : { itemId: sourceWasSyntheticInstruction ? durable.checkpoint.sourceIdentity : sourceWork.instructionIdentity,
            ...(sourceWork.nativeTurnId ? { turnId: sourceWork.nativeTurnId } : {}), content: [],
            ...(sourceWasDelegation ? { instructionEnvelope: { role: "tool_result" } } : {}) } };
      durableSources.set(parsed, retained);
    }
    return { source: retained.source, summaryIndex: durable.summaryIndex, sourceWasDelegation, sourceWasGoal, sourceWasSyntheticInstruction };
  }

  const accepted = acceptedCheckpoint(parsed, identity);
  return accepted ? {
    source: structuredClone(accepted.checkpoint.source), summaryIndex: accepted.summaryIndex,
    sourceWasSyntheticInstruction: accepted.checkpoint.sourceWasSyntheticInstruction,
    sourceWasDelegation: accepted.checkpoint.sourceWasDelegation, sourceWasGoal: accepted.checkpoint.sourceWasGoal,
  } : undefined;
}

/** A new instruction after compaction keeps its own consumer identity. Only recognize the
 * committed prefix for environment validation; the caller must still check the native rollout. */
export function hasCompactionEnvironmentCheckpoint(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): boolean {
  if (recoverCompactionInstruction(parsed, identity)) {
    if (parsed._conversationPolicy !== "task") return true;
    const carried = requestCarriedChatGptInstructionRevision(parsed, identity.turnId);
    return !carried || isAcceptedCompactionContinuation(parsed, identity, carried);
  }
  if (parsed._conversationPolicy !== "task") return false;
  const body = parsed._rawBody as { input?: unknown[] } | undefined;
  const input = body?.input;
  if (!Array.isArray(input)) return false;
  const checkpoint = continuityCheckpoint(parsed);
  if (checkpoint.index < 0 || checkpoint.index === input.length - 1) return false;
  // Do not change the original request or cache this projection as admission evidence.
  const prefix = { ...parsed, _rawBody: { ...body, input: input.slice(0, checkpoint.index + 1) } };
  const recovered = recoverCompactionInstruction(prefix, identity);
  if (!recovered) return false;
  const carried = requestCarriedChatGptInstructionRevision(prefix, identity.turnId);
  return !carried || isAcceptedCompactionContinuation(prefix, identity, carried);
}

function acceptedCheckpoint(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): { checkpoint: CompletedCheckpoint; summaryIndex: number } | undefined {
  const key = scope(parsed, identity);
  const checkpoint = key ? checkpoints.get(key) : undefined;
  if (!key || !checkpoint) return undefined;
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) return undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") continue;
    let summary: string | null;
    if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
      summary = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
    } else {
      if (item.type !== "message" || item.role !== "user") continue;
      const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
        ? item.content.map(part => part?.text ?? "").join("\n") : "";
      if (!isReadableCompactionSummaryText(text)) continue;
      summary = text.slice(SUMMARY_PREFIX.length + 1);
    }
    const owner = (item.internal_chat_message_metadata_passthrough as { turn_id?: unknown } | undefined)?.turn_id;
    if (owner !== undefined && owner !== identity.turnId) return undefined;
    return summary !== null && acceptsSummary(key, checkpoint, summary) ? { checkpoint, summaryIndex: index } : undefined;
  }
  return undefined;
}

function acceptsSummary(key: string, checkpoint: CompletedCheckpoint, summary: string): boolean {
  if (digest(summary) !== checkpoint.summaryHash) return false;
  // A long-running continuation does not become invalid merely because time passed. Keep the
  // bounded registry ordered by actual use instead of expiring a still-active native turn.
  checkpoints.delete(key);
  checkpoints.set(key, checkpoint);
  return true;
}
