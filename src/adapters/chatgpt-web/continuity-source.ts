import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { canonicalJson } from "./canonical-json";
import { continuityError } from "./continuity-errors";
import { hasNativeChatGptInstruction, requestCarriedChatGptInstructionRevision, type ChatGptTurnUserRevision } from "./environment-instruction";
import type { RecoveryCheckpointRecord, RecoveryWorkRecord } from "./continuity-recovery-store";

export function continuityDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function continuitySourceRepresentationDigest(parsed: CodexParsedRequest, source: ChatGptTurnUserRevision): string {
  return continuityDigest([source.turnId,
    source.itemId ? parsed._chatGptMessageIdAliases?.[source.itemId] ?? source.itemId : null,
    source.content, source.instructionEnvelope ?? { role: "user" }]);
}

/** Validate a unique retained primary; repeated echoes keep the ordinary request routing. */
export function recoveryContinuationPrimaryIndices(
  parsed: CodexParsedRequest,
  checkpoint: Pick<RecoveryCheckpointRecord, "sourceIdentity" | "representationDigests">,
  source: Pick<RecoveryWorkRecord, "nativeTurnId">,
): number[] {
  const raw = (parsed._rawBody as { input: unknown[] }).input;
  const primaryIndices = raw.flatMap((value, index) => {
    const item = value as { id?: unknown; internal_chat_message_metadata_passthrough?: { turn_id?: unknown } } | undefined;
    const matchesId = typeof item?.id === "string" && (parsed._chatGptMessageIdAliases?.[item.id] ?? item.id) === checkpoint.sourceIdentity;
    const matchesTurn = !item?.id && checkpoint.sourceIdentity === `turn:${source.nativeTurnId}`
      && item?.internal_chat_message_metadata_passthrough?.turn_id === source.nativeTurnId && hasNativeChatGptInstruction(parsed, [value]);
    return matchesId || matchesTurn ? [index] : [];
  });
  if (primaryIndices.length === 1) {
    const primary = requestCarriedChatGptInstructionRevision({ ...parsed,
      _rawBody: { ...(parsed._rawBody as object), input: [raw[primaryIndices[0]!]] } }, source.nativeTurnId);
    if (!primary || !checkpoint.representationDigests.includes(continuitySourceRepresentationDigest(parsed, primary))) {
      throw continuityError("continuity_source_unproven", "The checkpoint primary conflicts with its accepted source.");
    }
  }
  return primaryIndices;
}
