import { ChatGptWebAdapterError } from "./adapter-error";

export type ContinuityErrorCode =
  | "continuity_unverified"
  | "continuity_execution_unsettled"
  | "continuity_context_missing"
  | "continuity_result_conflict"
  | "continuity_replay_unavailable"
  | "continuity_legacy_unproven"
  | "continuity_stopped"
  | "continuity_retry_exhausted"
  | "continuity_session_lost"
  | "continuity_source_unproven"
  | "continuity_manual_handoff_required"
  | "continuity_configuration_conflict"
  | "continuity_input_limit"
  | "continuity_resource_capacity";

const messages: Record<ContinuityErrorCode, string> = {
  continuity_unverified: "The previous conversation could not be verified. Retry after the connection is available.",
  continuity_execution_unsettled: "The previous writer or delivered tool calls have not settled. No replacement work was started.",
  continuity_context_missing: "Recovery requires the current instruction and the real results of its issued tool calls.",
  continuity_result_conflict: "A required tool result conflicts with its first accepted result.",
  continuity_replay_unavailable: "This work already completed, but its result body is no longer available. It cannot run again.",
  continuity_legacy_unproven: "This older registration has no complete recovery evidence. Its previous writer and tools must be proved settled.",
  continuity_stopped: "This instruction was explicitly stopped. A new user instruction may start new work.",
  continuity_retry_exhausted: "This work has exhausted its three recovery retries within the 30-minute recovery window.",
  continuity_session_lost: "The previous conversation is unavailable. Recovery requires settled execution and valid current context.",
  continuity_source_unproven: "The current instruction, history revision, or exact compaction source cannot be proved.",
  continuity_manual_handoff_required: "Zero Risk finished before a compaction handoff was delivered. The completed answer and tool results are preserved; no new prompt was copied or sent.",
  continuity_configuration_conflict: "Session continuity first is incompatible with the current configuration or component versions.",
  continuity_input_limit: "The actual next ChatGPT prompt exceeds the original single-input boundary. The larger execution history budget does not increase this boundary.",
  continuity_resource_capacity: "Session continuity storage or browser capacity is full. Existing tasks were not evicted.",
};

/** Reasons supplied here are fixed implementation text, never raw tools, prompts or credentials. */
export function continuityError(code: ContinuityErrorCode, reason?: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(`${messages[code]}${reason ? ` ${reason}` : ""}`, {
    status: code === "continuity_input_limit" ? 400 : code === "continuity_unverified" ? 503 : 409,
    errorType: code === "continuity_unverified" ? "server_error" : "invalid_request_error",
    code,
    retryable: code === "continuity_unverified",
  });
}
