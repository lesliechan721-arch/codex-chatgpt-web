export const NATIVE_WAIT_PROTOCOL_VERSION = 1;
export const NATIVE_WAIT_WINDOW_MS = 30_000;
export const NATIVE_WAIT_LEASE_MS = 120_000;

export const NATIVE_WAIT_INSTRUCTIONS = [
  "Before any Native operation, verify that this connector exposes codex_tool_wait and operation_id on its Native entry schemas; otherwise stop and ask to refresh the current connector and update the runtime/helper.",
  "For each new logical Native call, allocate the next positive safe integer operation_id within the current capability before sending the original tool call. Concurrent calls need distinct IDs.",
  "Start from 1 in a new capability, retain the counter across MCP/Tunnel/Responses reconnects, and never reuse an old ID for a new logical call even when the parameters match.",
  "A codex_native_pending receipt is bridge control, not a Native result or task completion. Keep calling codex_tool_wait with the same capability and operation_id until the public result arrives.",
  "After a lost start or result receipt, retry the identical original call with the same capability, operation_id, arguments and task_revision, or call codex_tool_wait on that ID. Recovery does not require a prior pending receipt; do not execute a new logical call to recover the result.",
  "After an infrastructure or transport failure, attempt this receipt recovery before ending the task. A failed query leaves Native execution status unconfirmed; it does not prove that the operation failed or the task was cancelled. If codex_tool_wait reports an unknown ID after a lost start receipt, retry the identical original start with its original capability, ID, arguments and revision. Stop recovery if the Broker reports cancellation, capability retirement, lease expiry or another terminal error; never move an uncertain operation to a new capability to repeat it.",
  "Do not repeat input questions, treat repeated pending as failure, or emit the same progress update for each query. Continue waiting while the Broker returns pending. If recovery remains unavailable within the task's limits, report the unresolved operation and its unconfirmed execution status; do not claim successful completion.",
  "The codex.control.compaction_handoff control call does not create an operation and does not require operation_id.",
].join(" ");
