import { createHash } from "node:crypto";
import { decodeCompactionSummary, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import { canonicalJson } from "./canonical-json";
import { continuityError } from "./continuity-errors";
import { requestCarriedChatGptInstructionRevision } from "./environment";
import type { RecoveryCheckpointRecord, RecoveryThreadRecord, RecoveryWorkRecord } from "./continuity-recovery-store";

export interface RecoveryContinuationSelection {
  checkpoint: RecoveryCheckpointRecord;
  /** The source for first admission, or the recorded consumer for every later attempt. */
  work: RecoveryWorkRecord;
  consumerLogicalWorkId?: string;
  action: "admit" | "resume" | "replay" | "stopped";
  summaryIndex: number;
}
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

function summary(item: Record<string, unknown>): string | undefined {
  if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
    const decoded = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
    if (decoded === null) throw continuityError("continuity_source_unproven", "The checkpoint representation is invalid.");
    return decoded;
  }
  if (item.role !== "user" || (item.type !== undefined && item.type !== "message")) return undefined;
  const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
    ? item.content.map(part => object(part) && typeof part.text === "string" ? part.text : "").join("\n") : "";
  return text.startsWith(`${SUMMARY_PREFIX}\n`) ? text.slice(SUMMARY_PREFIX.length + 1) : undefined;
}

/** Read-only recognition; only durable admission may consume a continuation or grant a writer. */
export function selectRecoveryContinuation(
  parsed: CodexParsedRequest,
  record: RecoveryThreadRecord,
  identity: { threadId?: string; turnId?: string },
): RecoveryContinuationSelection | undefined {
  if (parsed._conversationPolicy !== "continuity-first") return undefined;
  if (!identity.threadId || !identity.turnId || record.thread !== digest(identity.threadId)
    || parsed._continuityScope !== record.scope) {
    throw continuityError("continuity_source_unproven", "The checkpoint request does not match its durable thread and scope.");
  }
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) return undefined;
  const summaries = new Map<string, Array<{ index: number; nativeTurnId?: unknown }>>();
  for (let index = 0; index < input.length; index++) {
    const item = input[index];
    if (!object(item)) continue;
    const text = summary(item);
    if (text === undefined) continue;
    const metadata = item.internal_chat_message_metadata_passthrough;
    const entries = summaries.get(digest(text)) ?? [];
    entries.push({ index, ...(object(metadata) && metadata.turn_id !== undefined ? { nativeTurnId: metadata.turn_id } : {}) });
    summaries.set(digest(text), entries);
  }
  if (!summaries.size) return undefined;
  if (record.legacyUnproven) throw continuityError("continuity_legacy_unproven");
  let candidates = Object.values(record.checkpoints).flatMap(checkpoint => {
    const representations = summaries.get(checkpoint.summaryDigest);
    if (!representations) return [];
    const source = record.works[checkpoint.sourceLogicalWorkId];
    if (!source || source.purpose !== "ordinary" || source.workLineageId !== checkpoint.workLineageId) {
      throw continuityError("continuity_context_missing", "The checkpoint source relation is no longer complete.");
    }
    const consumerId = checkpoint.continuation.consumerLogicalWorkId;
    const work = checkpoint.continuation.state === "consumed" && consumerId ? record.works[consumerId] : source;
    if (!work || work.purpose !== "ordinary" || work.workLineageId !== checkpoint.workLineageId) {
      throw continuityError("continuity_context_missing", "The recorded continuation consumer is no longer retained.");
    }
    const nativeTurn = checkpoint.continuation.nativeTurnId ?? work.nativeTurnId;
    if (nativeTurn !== identity.turnId || (consumerId && work.nativeTurnId !== identity.turnId)) return [];
    const representation = representations.findLast(item => item.nativeTurnId === undefined
      || item.nativeTurnId === identity.turnId || item.nativeTurnId === source.nativeTurnId);
    if (!representation) throw continuityError("continuity_source_unproven", "The checkpoint representation belongs to a different native source.");
    const summaryIndex = representation.index;
    if (checkpoint.ordinaryFinalReceiptId && source.terminalReceiptId !== checkpoint.ordinaryFinalReceiptId) {
      throw continuityError("continuity_source_unproven", "The checkpoint ordinary-final receipt conflicts with its source.");
    }
    return [{ checkpoint, source, work, summaryIndex, consumerId }];
  });
  const carried = requestCarriedChatGptInstructionRevision(parsed, identity.turnId);
  const carriedId = carried?.itemId ? parsed._chatGptMessageIdAliases?.[carried.itemId] ?? carried.itemId : undefined;
  const representationDigest = carried ? digest([carried.turnId, carriedId ?? null,
    carried.content, carried.instructionEnvelope ?? { role: "user" }]) : undefined;
  if (carried) {
    const explicit = candidates.filter(({ checkpoint, source }) => (
      carriedId !== undefined && carriedId === checkpoint.sourceIdentity
        && (carried.turnId === undefined || carried.turnId === source.nativeTurnId)
    ) || checkpoint.representationDigests.includes(representationDigest!));
    if (explicit.length > 0) {
      if (explicit.some(({ checkpoint }) => !checkpoint.representationDigests.includes(representationDigest!))) {
        throw continuityError("continuity_source_unproven", "The retained instruction conflicts with its accepted checkpoint source.");
      }
      candidates = explicit;
    } else if (carriedId && carried.turnId === identity.turnId) {
      // A new current instruction has its own admission path; a summary cannot replace it.
      return undefined;
    }
  }
  if (candidates.length > 1) {
    // A real issued call can distinguish source boundaries. It cannot select the latest head.
    const terminal = input.findLast(item => object(item)
      && ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(String(item.type))
      && typeof item.call_id === "string" && record.calls[item.call_id] !== undefined);
    if (object(terminal) && typeof terminal.call_id === "string") {
      const call = record.calls[terminal.call_id]!;
      candidates = candidates.filter(({ checkpoint }) => checkpoint.workLineageId === call.workLineageId
        && checkpoint.coveredCallIds.includes(call.callId)
        && checkpoint.sourceToolBatchHeadSequence === call.batchSequence);
    }
  }
  if (candidates.length > 1) throw continuityError("continuity_source_unproven", "The checkpoint request cannot distinguish its durable continuation source.");
  const selected = candidates[0];
  if (!selected) return undefined;
  const { checkpoint, work, summaryIndex, consumerId } = selected;
  const action = work.state === "stopped" ? "stopped" : work.state === "completed" ? "replay"
    : checkpoint.continuation.state === "consumed" ? "resume" : "admit";
  if (checkpoint.ordinaryFinalReceiptId && action === "admit") {
    throw continuityError("continuity_source_unproven", "A completed ordinary source cannot admit checkpoint-only replacement work.");
  }
  return { checkpoint, work, summaryIndex, action, ...(consumerId ? { consumerLogicalWorkId: consumerId } : {}) };
}
