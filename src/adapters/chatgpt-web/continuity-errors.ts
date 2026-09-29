import { ChatGptWebAdapterError } from "./adapter-error";

export type ContinuityErrorCode =
  | "continuity_session_lost"
  | "continuity_source_unproven"
  | "continuity_manual_handoff_required"
  | "continuity_configuration_conflict"
  | "continuity_input_limit"
  | "continuity_resource_capacity";

const messages: Record<ContinuityErrorCode, string> = {
  continuity_session_lost: "The exact ChatGPT conversation is no longer owned by this runtime. It will not be recreated.",
  continuity_source_unproven: "The current history revision or exact compaction source cannot be proved. No replacement conversation will be created.",
  continuity_manual_handoff_required: "Zero Risk finished before a compaction handoff was delivered. The completed answer and tool results are preserved; no new prompt was copied or sent.",
  continuity_configuration_conflict: "Session continuity first is incompatible with the current configuration or component versions.",
  continuity_input_limit: "The actual next ChatGPT prompt exceeds the original single-input boundary. The larger execution history budget does not increase this boundary.",
  continuity_resource_capacity: "Session continuity storage or browser capacity is full. Existing tasks were not evicted.",
};

/** Reasons supplied here are fixed implementation text, never raw tools, prompts or credentials. */
export function continuityError(code: ContinuityErrorCode, reason?: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(`${messages[code]}${reason ? ` ${reason}` : ""}`, {
    status: code === "continuity_input_limit" ? 400 : 409,
    errorType: "invalid_request_error",
    code,
    retryable: false,
  });
}
