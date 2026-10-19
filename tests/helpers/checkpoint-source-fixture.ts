import { parseRequest } from "../../src/responses/parser";
import { encodeCompactionSummary } from "../../src/responses/compaction";
import { requestCarriedChatGptInstructionRevision } from "../../src/adapters/chatgpt-web/environment-instruction";
import { continuityDigest, continuitySourceRepresentationDigest, recoveryContinuationPrimaryIndices } from "../../src/adapters/chatgpt-web/continuity-source";
import { selectRecoveryContinuation, type RecoveryContinuationRecord } from "../../src/adapters/chatgpt-web/continuity-recovery-continuation";

export const checkpointSourceIdentity = { threadId: "source-pilot-thread", turnId: "turn-first" };
export const checkpointSourceScope = continuityDigest("source-pilot-scope");
export const checkpointSourceSummary = "Accepted source result; continue the original task.";
export const checkpointSourceThread = continuityDigest(checkpointSourceIdentity.threadId);

export function checkpointSourceRequest(input: unknown[]) {
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: structuredClone(input), client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: checkpointSourceIdentity.threadId, turn_id: checkpointSourceIdentity.turnId,
      request_kind: "turn", subagent_kind: "thread_spawn", parent_thread_id: "parent-thread", agent_name: "/root/child" }),
  } });
  parsed._conversationPolicy = "task";
  parsed._continuityScope = checkpointSourceScope;
  return parsed;
}

export function checkpointSourceItem(parent = false, structured = false): Record<string, unknown> {
  const common = { id: "source-instruction", content: structured ? [
    { type: "input_text", text: "Original source instruction." },
    { type: "input_text", text: "Keep the ordered second part." },
  ] : "Original source content.", internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  return parent ? { ...common, type: "agent_message", author: "/root", recipient: "/root/child" }
    : { ...common, type: "message", role: "user" };
}

export const checkpointSourceMarker = () => ({ type: "compaction", encrypted_content: encodeCompactionSummary(checkpointSourceSummary) });

/** An independent read view, with no write, owner, locking or backend capability. */
export function checkpointSourceView(original: Record<string, unknown>): RecoveryContinuationRecord {
  const parsed = checkpointSourceRequest([original]);
  const source = requestCarriedChatGptInstructionRevision(parsed, checkpointSourceIdentity.turnId)!;
  return {
    thread: checkpointSourceThread, scope: checkpointSourceScope, legacyUnproven: false, calls: {},
    works: { source: { logicalWorkId: "source", instructionIdentity: source.itemId!, nativeTurnId: source.turnId,
      workPayloadDigest: continuityDigest("source-payload"), purpose: "ordinary", state: "prepared", workLineageId: "source", acceptedTaskRevision: 1,
      attempts: [{ attempt: 0, epoch: 0, historyRevision: 0, snapshotVersion: 0, snapshotDigest: continuityDigest("source-snapshot"),
        stage: "interrupted-settled", dispatchProtocolComplete: true, writerRetired: true }] } },
    checkpoints: { "commit-one": { commitId: "commit-one", compactionTargetId: "source-target", sourceLogicalWorkId: "source",
      workLineageId: "source", acceptedTaskRevision: 1, sourceHistoryRevision: 0, targetHistoryRevision: 1,
      sourceToolBatchHeadSequence: 0, sourceIdentity: source.itemId!, representationDigests: [continuitySourceRepresentationDigest(parsed, source)],
      checkpointBytes: 0, summaryDigest: continuityDigest(checkpointSourceSummary), coveredCallIds: [], retainedBodyBytes: 0,
      continuation: { state: "available", nativeTurnId: checkpointSourceIdentity.turnId } } },
  };
}

/** The same selector and unique-primary decision used by durable request preparation. */
export function checkpointSourceDecision(input: unknown[], record: RecoveryContinuationRecord) {
  const parsed = checkpointSourceRequest(input);
  const beforeInput = structuredClone(parsed._rawBody), beforeRecord = structuredClone(record);
  try {
    const carried = requestCarriedChatGptInstructionRevision(parsed, checkpointSourceIdentity.turnId);
    const selection = selectRecoveryContinuation(parsed, record, checkpointSourceIdentity);
    if (!selection) return { action: "none", carried: Boolean(carried) };
    const source = record.works[selection.checkpoint.sourceLogicalWorkId]!;
    const primary = recoveryContinuationPrimaryIndices(parsed, selection.checkpoint, source);
    return { action: selection.action, carried: Boolean(carried), commit: selection.checkpoint.commitId,
      work: selection.work.logicalWorkId, consumer: selection.consumerLogicalWorkId,
      summaryIndex: selection.summaryIndex, primary };
  } finally {
    // Equality is checked by the caller so failures remain visible in both contract paths.
    if (JSON.stringify(parsed._rawBody) !== JSON.stringify(beforeInput) || JSON.stringify(record) !== JSON.stringify(beforeRecord)) {
      throw new Error("Source recognition changed its request or committed record");
    }
  }
}

export function changedCheckpointSource(original: Record<string, unknown>, change: "role" | "content" | "turn" | "author" | "recipient") {
  if (change === "role") {
    const changed = { ...original };
    if (original.type === "agent_message") {
      delete changed.author; delete changed.recipient;
      return { ...changed, type: "message", role: "user" };
    }
    delete changed.role;
    return { ...changed, type: "agent_message", author: "/root", recipient: "/root/child" };
  }
  return change === "content" ? { ...original, content: "Changed source content." }
    : change === "turn" ? { ...original, internal_chat_message_metadata_passthrough: { turn_id: "changed-source-turn" } }
    : { ...original, [change]: "/root/other" };
}
