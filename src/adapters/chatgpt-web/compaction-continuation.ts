import { createHash } from "node:crypto";
import { decodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import type { ChatGptTurnIdentity, ChatGptTurnUserRevision } from "./environment";
import { continuityError } from "./continuity-errors";
import { canonicalJson } from "./canonical-json";

interface CompletedCheckpoint {
  summaryHash: string;
  sourceHashes: ReadonlySet<string>;
  source: ChatGptTurnUserRevision;
  protectedScope?: string;
  threadHash?: string;
}

// Evidence of a checkpoint actually returned by this daemon, not authority inferred from text
// that happens to look like a summary. A new process must not invent a missing handoff.
const checkpoints = new Map<string, CompletedCheckpoint>();
const MAX_CHECKPOINTS = 256;
const reservations = new Set<string>();

function scope(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): string | undefined {
  if (!identity.threadId || !identity.turnId) return undefined;
  const base = [identity.threadId, identity.turnId, parsed.modelId, parsed.options.reasoning];
  if (parsed._conversationPolicy !== "continuity-first") return JSON.stringify(base);
  if (!parsed._continuityScope) return undefined;
  return digest([...base, "continuity-first", parsed._chatgptModelFamily, parsed._continuityScope]);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceDigest(parsed: CodexParsedRequest, source: ChatGptTurnUserRevision): string {
  return parsed._conversationPolicy === "continuity-first"
    ? createHash("sha256").update(canonicalJson([source.turnId,
      source.itemId ? parsed._chatGptMessageIdAliases?.[source.itemId] ?? source.itemId : null,
      source.content, source.instructionEnvelope ?? { role: "user" }])).digest("hex")
    : digest([source.turnId, source.content]);
}

function makeCheckpointRoom(key: string): void {
  if (checkpoints.has(key) || reservations.has(key)) return;
  while (new Set([...checkpoints.keys(), ...reservations]).size >= MAX_CHECKPOINTS) {
    const evictable = [...checkpoints].find(([candidate, checkpoint]) => !checkpoint.protectedScope && !reservations.has(candidate));
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

export function releaseContinuityContinuationEvidence(protectedScope: string, threadHash: string): void {
  for (const [key, checkpoint] of checkpoints) {
    if (checkpoint.protectedScope === protectedScope && checkpoint.threadHash === threadHash) checkpoints.delete(key);
  }
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
  const acceptedSource = structuredClone(sources[0]);
  if (parsed._conversationPolicy === "continuity-first" && acceptedSource.itemId) {
    acceptedSource.itemId = parsed._chatGptMessageIdAliases?.[acceptedSource.itemId] ?? acceptedSource.itemId;
  }
  const sourceHashes = prior?.summaryHash === digest(summary) ? new Set(prior.sourceHashes) : new Set<string>();
  for (const source of sources) sourceHashes.add(sourceDigest(parsed, source));
  checkpoints.delete(key);
  checkpoints.set(key, {
    summaryHash: digest(summary), sourceHashes,
    source: prior?.summaryHash === digest(summary) ? prior.source : acceptedSource,
    ...(parsed._conversationPolicy === "continuity-first" ? {
      protectedScope: parsed._continuityScope, threadHash: digest(identity.threadId),
    } : {}),
  });
}

export function isAcceptedCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): boolean {
  return acceptedCheckpoint(parsed, identity)?.checkpoint.sourceHashes.has(sourceDigest(parsed, source)) === true;
}

/** Native compaction may retain only its summary; recover the task solely from our completed handoff. */
export function recoverCompactionInstruction(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): { source: ChatGptTurnUserRevision; summaryIndex: number } | undefined {
  const accepted = acceptedCheckpoint(parsed, identity);
  return accepted ? { source: structuredClone(accepted.checkpoint.source), summaryIndex: accepted.summaryIndex } : undefined;
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
  if (!checkpoint.protectedScope) {
    checkpoints.delete(key);
    checkpoints.set(key, checkpoint);
  }
  return true;
}
