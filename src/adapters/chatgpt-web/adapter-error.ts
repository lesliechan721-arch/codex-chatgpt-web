import { adapterFailureFromMessage, classifyError } from "../../lib/errors";
import { NativeOperationError } from "./native-tool-operations";

export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

// Exact implementation codes are safe to log. Pattern checks alone can accept a credential.
const browserLogCodes = new Set([
  "browser_interaction_mode_mismatch", "browser_stream_inconsistent", "chatgpt_effort_locked",
  "chatgpt_attachment_upload_failed", "chatgpt_response_incomplete", "chatgpt_security_check", "chatgpt_session_expired",
  "chatgpt_sign_in_required", "chatgpt_stopped_thinking", "chatgpt_subscription_unavailable",
  "chatgpt_submission_ambiguous", "chatgpt_submitted_turn_failed", "client_cancelled", "client_closed_request",
  "codex_context_selection_required", "codex_context_upgrade_required", "codex_tool_admission_rejected",
  "codex_tool_cancelled", "codex_tool_compaction_pending", "codex_tool_infrastructure_failure",
  "codex_tool_native_deadline", "codex_tool_not_started", "codex_tool_operation_conflict",
  "codex_tool_operation_id_required", "codex_tool_operation_retired", "codex_tool_operation_unknown",
  "codex_tool_resource_limit", "codex_tool_timeout", "codex_tool_upgrade_required", "codex_tool_wait_lease_expired",
  "compaction_control_unavailable", "compaction_handoff_missing", "compaction_handoff_timeout", "compaction_source_unavailable",
  "connector_not_found", "context_length_exceeded", "continuity_unverified", "continuity_execution_unsettled",
  "continuity_context_missing", "continuity_result_conflict", "continuity_replay_unavailable", "continuity_legacy_unproven",
  "continuity_stopped", "continuity_retry_exhausted", "continuity_session_lost", "continuity_source_unproven",
  "continuity_manual_handoff_required", "continuity_configuration_conflict", "continuity_input_limit",
  "continuity_resource_capacity", "continuity_recovery_retired", "invalid_output_schema", "manual_handoff_timeout",
  "manual_launcher_failed", "manual_turn_cancelled", "missing_delegated_turn_identity",
  "model_version_unavailable", "prompt_attachment_integrity", "rate_limit_exceeded",
  "structured_output_validation_failed", "task_update_capacity", "task_update_compaction_pending", "task_update_driver_stale",
  "task_update_final_output_started", "task_update_invalid", "task_update_message_conflict", "task_update_no_boundary",
  "task_update_not_executed", "task_update_output_stale", "task_update_output_unproven", "task_update_pending",
  "task_update_prepared", "task_update_protocol_missing", "task_update_result_invalid", "task_update_result_type_invalid",
  "task_update_revision_required", "task_update_source_conflict", "task_update_source_stale", "task_update_source_unproven",
  "task_update_stale", "task_update_transfer_busy", "task_update_transfer_conflict", "task_update_transfer_pending",
  "task_update_transfer_unknown", "task_update_unacknowledged", "task_update_upgrade_required",
  "thread_environment_state_invalid", "too_many_attachments", "upload_quota_exceeded", "upstream_server_error", "server_is_overloaded",
  "invalid_request_error", "invalid_api_key", "permission_denied", "subscription_required", "insufficient_quota",
  "BUDGET_EXCEEDED", "CONTEXT_BUDGET_EXCEEDED", "CONTEXT_BUSY", "CONTEXT_IMAGE_UNAVAILABLE", "CONTEXT_INVALID",
  "CONTEXT_NAVIGATION_STOPPED", "CONTEXT_NOT_READY", "CONTEXT_RETIRED", "CONTEXT_SOURCE_UNAVAILABLE", "CONTEXT_VERIFICATION_ONLY",
]);
const browserLogErrorTypes = new Set([
  "server_error", "upstream_error", "invalid_request_error", "client_closed_request", "client_cancelled",
  "rate_limit_error", "authentication_error", "permission_error", "insufficient_quota", "connector_error",
]);

/** Fixed summaries only: messages, causes and arbitrary error properties can contain task data. */
export function chatGptBrowserErrorLog(error: Error): Record<string, string | number | boolean> {
  const structured = error instanceof ChatGptWebAdapterError || error instanceof NativeOperationError;
  const inferred = structured ? undefined : adapterFailureFromMessage(error.message);
  const candidateCode = structured ? error.code : inferred?.error.code;
  const code = candidateCode && browserLogCodes.has(candidateCode) ? candidateCode : undefined;
  const status = error instanceof ChatGptWebAdapterError ? error.status : inferred?.httpStatus;
  const candidateType = error instanceof ChatGptWebAdapterError ? error.errorType : inferred?.error.type;
  const errorType = candidateType && browserLogErrorTypes.has(candidateType) ? candidateType : undefined;
  let reason = "browser_execution_failed";
  if (code === "server_is_overloaded") reason = "upstream_overloaded";
  else if (error.name === "AbortError" || status === 499 || code?.includes("cancel") || code === "continuity_stopped"
    || code === "CONTEXT_NAVIGATION_STOPPED") reason = "task_cancelled";
  else if (code?.includes("upgrade_required") || code === "task_update_protocol_missing"
    || code === "continuity_configuration_conflict") reason = "protocol_incompatible";
  else if (code?.includes("source") || code === "continuity_context_missing" || code === "continuity_session_lost"
    || code === "continuity_replay_unavailable" || code === "CONTEXT_IMAGE_UNAVAILABLE"
    || code === "CONTEXT_SOURCE_UNAVAILABLE") reason = "source_unavailable";
  else if (code?.includes("timeout") || code === "codex_tool_native_deadline" || status === 504) reason = "execution_timeout";
  else if (!structured) {
    const message = error.message.toLowerCase();
    if (/does not support|protocol.{0,40}(?:incompatible|missing)|update (?:or restart )?the (?:launcher|connector|runtime|helper)/.test(message)) {
      reason = "protocol_incompatible";
    } else if (/(?:context|compaction|history|source).*(?:unavailable|not available|not fully readable|cannot be proved)/.test(message)) {
      reason = "source_unavailable";
    }
  }
  // The fallback classification also uses fixed text; never pass an exception to JSON.stringify.
  const fallback = classifyError(status ?? 502, errorType ?? "server_error", "");
  return {
    reason, code: code ?? fallback.code ?? "upstream_server_error", errorType: errorType ?? fallback.type,
    ...(typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}),
    ...(error instanceof ChatGptWebAdapterError ? { retryable: error.retryable === true } : {}),
  };
}

export function chatGptToolTimeoutError(tool: string, timeoutMs: number): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `Codex tool ${tool} did not return a result within ${timeoutMs / 1_000} seconds. `
    + "The turn was stopped. Check whether the command is still running or waiting for approval before retrying.",
    { status: 504, errorType: "server_error", code: "codex_tool_timeout", retryable: false },
  );
}

export function chatGptResponseIncompleteError(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 502, errorType: "server_error", code: "chatgpt_response_incomplete", retryable: false,
  });
}

export function chatGptToolApprovalRequiredError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT is waiting for plugin permission. Open the plugin's settings in ChatGPT, "
    + 'then Permissions → Allow all actions, and retry this turn.',
    { status: 403, errorType: "permission_error", code: "chatgpt_tool_approval_required", retryable: false },
  );
}

// Only the compaction owner may signal this after the broker accepts its one-shot handoff.
// It cancels browser observation, while the accepted summary remains the native result.
export class ChatGptCompactionHandoffAccepted extends DOMException {
  constructor() {
    super("Structured compaction handoff accepted", "AbortError");
  }
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

/** Physical loss alone does not prove that the user stopped a durable task. */
export class ChatGptBrowserPageClosedError extends ChatGptWebAdapterError {
  constructor() {
    // Preserve the existing cancellation contract outside task + Launcher recovery.
    const cancellation = chatGptBrowserTabClosedError();
    super(cancellation.message, cancellation);
  }
}

export function chatGptTurnSupersededError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "A newer Codex instruction superseded this ChatGPT response.",
    { status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT displayed 'Stopped thinking' and could not continue this response. "
    + "A ChatGPT Web usage limit may have been reached. Check the ChatGPT tab for the exact reason before retrying.",
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_stopped_thinking",
      retryable: false,
    },
  );
}

export function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer available.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_source_unavailable",
      retryable: false,
    },
  );
}
