export const NATIVE_WAIT_PROTOCOL_VERSION = 1;
export const NATIVE_WAIT_WINDOW_MS = 30_000;
export const NATIVE_WAIT_LEASE_MS = 120_000;

export const NATIVE_WAIT_INSTRUCTIONS = [
  "Before any Native operation, verify that this connector exposes codex_tool_wait and operation_id on its Native entry schemas; otherwise stop and ask to refresh the current connector and update the runtime/helper.",
  "For each new logical Native call, allocate the next positive safe integer operation_id within the current capability before sending the original tool call. Concurrent calls need distinct IDs.",
  "Start from 1 in a new capability, retain the counter across MCP/Tunnel/Responses reconnects, and never reuse an old ID for a new logical call even when the parameters match.",
  "A codex_native_pending receipt is bridge control, not a Native result or task completion. Keep calling codex_tool_wait with the same capability and operation_id until the public result arrives.",
  "After a lost start or result receipt, retry the identical original call with the same operation_id, or wait on that ID; do not execute a new logical call to recover the result.",
  "Do not repeat input questions, treat repeated pending as failure, or emit the same progress update for each query. Do not finish while an operation is pending or its result has not been received.",
  "The codex.control.compaction_handoff control call does not create an operation and does not require operation_id.",
].join(" ");
